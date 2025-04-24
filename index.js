// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const kingsChatWebSdk = require('kingschat-web-sdk');

// const app = express();
// const PORT = process.env.PORT || 3000;

// app.use(cors());
// app.use(express.json());

// /**
//  * Send KingsChat Messages API
//  * POST /api/send-message
//  * Body: { accessToken, refreshToken, users, message }
//  */

// app.post('/api/send-message', async (req, res) => {
//   const { accessToken, refreshToken, users, message } = req.body;

//   if (!accessToken || !refreshToken || !users || !message) {
//     return res.status(400).json({
//       success: false,
//       error: 'Missing required fields (accessToken, refreshToken, users, message)'
//     });
//   }

//   try {
//     // If token is expired, refresh it first
//     let currentAccessToken = accessToken;
//     let currentRefreshToken = refreshToken;

//     // Send messages to all users
//     const results = await Promise.allSettled(
//       users.map(async (user) => {
//         try {
//           await kingsChatWebSdk.sendMessage({
//             message,
//             userIdentifier: user,
//             accessToken: currentAccessToken
//           });
//           return { user, status: 'success' };
//         } catch (error) {
//           // If token expired, refresh and retry 
//           if (error.message.includes('expired')) {
//             const refreshed = await kingsChatWebSdk.refreshAuthenticationToken({
//               clientId: process.env.KINGSCHAT_CLIENT_ID,
//               refreshToken: currentRefreshToken
//             });

//             currentAccessToken = refreshed.accessToken;
//             currentRefreshToken = refreshed.refreshToken;

//             await kingsChatWebSdk.sendMessage({
//               message,
//               userIdentifier: user,
//               accessToken: currentAccessToken
//             });
//             return { user, status: 'success_after_retry' };
//           }
//           return { user, status: 'failed', error: error.message };
//         }
//       })
//     );

//     // the responses
//     const successful = results.filter(r => r.value?.status.includes('success'));
//     const failed = results.filter(r => !r.value?.status.includes('success'));

//     res.json({
//       success: true,
//       stats: {
//         total: users.length,
//         successful: successful.length,
//         failed: failed.length
//       },
//       details: results.map(r => r.value || r.reason),
//       tokens: {
//         accessToken: currentAccessToken,
//         refreshToken: currentRefreshToken
//       }
//     });

//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       error: error.message
//     });
//   }
// });

// app.listen(PORT, () => {
//   console.log(`KingsChat API running on http://localhost:${PORT}`);
// });

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
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  exposedHeaders: [
    'Content-Length',
    'X-KingsChat-API-Version',
    'X-Request-ID'
  ],
  credentials: true,
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version
  });
});

/**
 * Send KingsChat Messages API
 * POST /api/send-message
 * Body: { accessToken, refreshToken, users, message }
 */
app.post('/api/send-message', async (req, res) => {
  // Set specific CORS headers for this endpoint
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const { accessToken, refreshToken, users, message } = req.body;

  // Validate required fields
  if (!accessToken || !refreshToken || !users || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields (accessToken, refreshToken, users, message)'
    });
  }

  // Validate users is an array
  if (!Array.isArray(users)) {
    return res.status(400).json({
      success: false,
      error: 'Users must be an array'
    });
  }

  try {
    let currentAccessToken = accessToken;
    let currentRefreshToken = refreshToken;

    // Send messages to all users
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
          // If token expired, refresh and retry 
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

    // Process the responses
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
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  if (err.name === 'CorsError') {
    return res.status(403).json({
      success: false,
      error: 'Not allowed by CORS policy'
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`KingsChat API running on port ${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});