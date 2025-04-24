require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kingsChatWebSdk = require('kingschat-web-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure allowed origins
const allowedOrigins = [
  'https://kingslist.pro',
  'http://localhost:3000',
  'https://kingslist-dispatch-api.onrender.com'
];

// Enhanced CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. First define your routes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { accessToken, refreshToken, users, message } = req.body;

    // Validate input
    if (!accessToken || !refreshToken || !users || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    if (!Array.isArray(users)) {
      return res.status(400).json({
        success: false,
        error: 'Users must be an array'
      });
    }

    let currentAccessToken = accessToken;
    let currentRefreshToken = refreshToken;

    const results = await Promise.allSettled(
      users.map(async (user) => {
        try {
          await kingsChatWebSdk.sendMessage({
            message,
            userIdentifier: user,
            accessToken: currentAccessToken
          });
          return { user, status: 'success' };
        } catch (error) {
          if (error.message.includes('expired') || error.message.includes('invalid token')) {
            try {
              const refreshed = await kingsChatWebSdk.refreshAuthenticationToken({
                clientId: process.env.KINGSCHAT_CLIENT_ID,
                refreshToken: currentRefreshToken
              });

              currentAccessToken = refreshed.accessToken;
              currentRefreshToken = refreshed.refreshToken;

              await kingsChatWebSdk.sendMessage({
                message,
                userIdentifier: user,
                accessToken: currentAccessToken
              });
              return { user, status: 'success_after_retry' };
            } catch (refreshError) {
              return { 
                user, 
                status: 'failed', 
                error: `Refresh failed: ${refreshError.message}` 
              };
            }
          }
          return { user, status: 'failed', error: error.message };
        }
      })
    );

    const successful = results.filter(r => r.value?.status.includes('success'));
    const failed = results.filter(r => !r.value?.status.includes('success'));

    res.json({
      success: true,
      stats: {
        total: users.length,
        successful: successful.length,
        failed: failed.length
      },
      details: results.map(r => r.value || r.reason),
      tokens: {
        accessToken: currentAccessToken,
        refreshToken: currentRefreshToken
      }
    });

  } catch (error) {
    console.error('Error in /api/send-message:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 2. Then add error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 3. Finally start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});