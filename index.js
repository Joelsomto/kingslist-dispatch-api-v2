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
  // CORS headers
  res.header('Access-Control-Allow-Origin', 'https://kingslist.pro');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  // Handle preflight
  if (req.method === 'OPTIONS') {
      return res.status(200).end();
  }

  try {
      const { refresh_token, client_id } = req.body;

      if (!refresh_token) {
          return res.status(400).json({ 
              error: 'invalid_request',
              error_description: 'Missing refresh token' 
          });
      }

      // Debugging logs
      console.log('Received refresh token request for client:', client_id);

      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refresh_token);
      params.append('client_id', client_id || process.env.KINGSCHAT_CLIENT_ID || '5d61e98b-7f02-4ea6-ac7a-9b193f2e425d');
      params.append('scope', 'openid profile email');

      const apiResponse = await fetch('https://connect.kingsch.at/developer/oauth2/token', {
          method: 'POST',
          headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
          },
          body: params
      });

      const responseData = await apiResponse.json();

      if (!apiResponse.ok) {
          console.error('King\'s Chat API error:', responseData);
          return res.status(apiResponse.status).json({
              error: responseData.error || 'token_refresh_failed',
              error_description: responseData.error_description || 'Token refresh failed'
          });
      }

      return res.json(responseData);

  } catch (err) {
      console.error('Token refresh error:', err);
      return res.status(500).json({ 
          error: 'server_error',
          error_description: err.message 
      });
  }
});

app.listen(PORT, () => {
  console.log(`KingsChat API running on http://localhost:${PORT}`);
});