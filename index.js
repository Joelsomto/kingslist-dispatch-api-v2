require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kingsChatWebSdk = require('kingschat-web-sdk');
const rateLimit = require('express-rate-limit');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(rateLimit({ 
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
}));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/**
 * Send KingsChat Messages API
 * POST /api/send-message
 * Body: { accessToken, refreshToken, users, message }
 */
app.post('/api/send-message', async (req, res) => {
  const { accessToken, refreshToken, users, message } = req.body;

  // Validate input
  if (!accessToken || !refreshToken || !users || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields (accessToken, refreshToken, users, message)'
    });
  }

  try {
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
          if (error.message.includes('expired')) {
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
    console.error('Error in send-message:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Export the Express app for Vercel
// Export the Express app for Vercel
module.exports = app;

// Only run server locally (not in Vercel)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}