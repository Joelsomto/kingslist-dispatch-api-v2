require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kingsChatWebSdk = require('kingschat-web-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/**
 * Send KingsChat Messages API
 * POST /api/send-message
 * Body: { accessToken, refreshToken, users, message }
 */

app.post('/api/send-message', async (req, res) => {
  const { accessToken, refreshToken, users, message } = req.body;

  if (!accessToken || !refreshToken || !users || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields (accessToken, refreshToken, users, message)'
    });
  }

  try {
    // If token is expired, refresh it first
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

    // the responses
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'refreshToken is required'
    });
  }

  try {
    const newTokens = await kingsChatWebSdk.refreshAuthenticationToken({
      clientId: process.env.KINGSCHAT_CLIENT_ID,
      refreshToken
    });

    res.json({
      success: true,
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresIn: newTokens.expiresInMillis
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Token refresh failed',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`KingsChat API running on http://localhost:${PORT}`);
});