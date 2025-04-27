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
const fetch = require('node-fetch'); // Added for fallback requests

const app = express();
const PORT = process.env.PORT || 3000;

// KingsChat API endpoints
const KINGSCHAT_API_PATHS = {
  prod: 'https://connect.kingsch.at',
  dev: 'https://connect-dev.kingsch.at'
};

app.use(cors());
app.use(express.json());

/**
 * Enhanced token refresh with SDK and fallback
 */
async function refreshKingsChatToken(refreshToken) {
  const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  
  try {
    // First try the SDK method
    const newTokens = await kingsChatWebSdk.refreshAuthenticationToken({
      clientId: process.env.KINGSCHAT_CLIENT_ID,
      refreshToken
    });
    
    return {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken, //
      expiresIn: newTokens.expiresInMillis
    };
  } catch (sdkError) {
    console.warn('SDK refresh failed, falling back to direct API call');
    
    // Fallback to direct API call
    const response = await fetch(`${KINGSCHAT_API_PATHS[environment]}/developer/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.KINGSCHAT_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in * 1000 // Convert to milliseconds
    };
  }
}

/**
 * Send KingsChat Messages API
 */
app.post('/api/send-message', async (req, res) => {
  const { accessToken, refreshToken, users, message } = req.body;

  if (!accessToken || !refreshToken || !users || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }

  try {
    let currentAccessToken = accessToken;
    let currentRefreshToken = refreshToken;
    let tokenRefreshAttempted = false;

    const results = await Promise.allSettled(
      users.map(async (user) => {
        try {
          // Try sending message
          await kingsChatWebSdk.sendMessage({
            message,
            userIdentifier: user,
            accessToken: currentAccessToken
          });
          return { user, status: 'success' };
          
        } catch (error) {
          // Handle token expiration (401) or invalid token
          if ((error.message.includes('expired') || error.message.includes('invalid_token')) && !tokenRefreshAttempted) {
            try {
              tokenRefreshAttempted = true;
              const newTokens = await refreshKingsChatToken(currentRefreshToken);
              
              currentAccessToken = newTokens.accessToken;
              currentRefreshToken = newTokens.refreshToken;
              
              // Retry with new token
              await kingsChatWebSdk.sendMessage({
                message,
                userIdentifier: user,
                accessToken: currentAccessToken
              });
              return { user, status: 'success_after_refresh' };
              
            } catch (refreshError) {
              return { 
                user, 
                status: 'failed', 
                error: refreshError.message 
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
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Token Refresh Endpoint
 */
/**
 * Token Refresh Endpoint
 */
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'refreshToken is required'
    });
  }

  try {
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    let newAccessToken;
    let newRefreshToken = refreshToken; // Default to original refresh token
    
    // First try the direct API call since SDK might not return new refresh token
    const response = await fetch(`${KINGSCHAT_API_PATHS[environment]}/developer/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.KINGSCHAT_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email'
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    
    // Check if new refresh token was provided
    newAccessToken = data.access_token;
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      newRefreshToken = data.refresh_token;
    }

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: data.expires_in * 1000 // Convert to milliseconds
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    
    // Fallback to SDK if direct call fails
    try {
      const newTokens = await kingsChatWebSdk.refreshAuthenticationToken({
        clientId: process.env.KINGSCHAT_CLIENT_ID,
        refreshToken
      });

      res.json({
        success: true,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken , //
        expiresIn: newTokens.expiresInMillis
      });
    } catch (sdkError) {
      res.status(401).json({
        success: false,
        error: 'Token refresh failed',
        details: sdkError.message
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`KingsChat API running on http://localhost:${PORT}`);
});