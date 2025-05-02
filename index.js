require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kingsChatWebSdk = require('kingschat-web-sdk');

const app = express();
const PORT =  process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function refreshTokens(refreshToken) {
  try {
    const refreshed = await kingsChatWebSdk.refreshAuthenticationToken({
      clientId: process.env.KINGSCHAT_CLIENT_ID,
      refreshToken
    });

    console.log('🔄 Tokens refreshed');
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken
    };
  } catch (err) {
    console.error('❌ Token refresh failed:', err.message);
    return null;
  }
}

// Strict retry until success
async function sendUntilSuccess({ user, message, accessToken, refreshToken }) {
  let currentAccessToken = accessToken;
  let currentRefreshToken = refreshToken;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      await kingsChatWebSdk.sendMessage({
        userIdentifier: user,
        message,
        accessToken: currentAccessToken
      });

      console.log(`✅ [${attempt}] Message sent successfully to ${user}`);
      return {
        success: true,
        accessToken: currentAccessToken,
        refreshToken: currentRefreshToken
      };
    } catch (error) {
      const detailedError = error.response?.data || error.message || 'Unknown error';
      console.error(`❌ [${attempt}] Failed to send message to ${user}:`, detailedError);

      // Refresh token and retry after short delay
      const newTokens = await refreshTokens(currentRefreshToken);
      if (newTokens) {
        currentAccessToken = newTokens.accessToken;
        currentRefreshToken = newTokens.refreshToken;
        console.log(`🔄 Token refreshed after failure for ${user}`);
      }

      await new Promise(res => setTimeout(res, 1000)); // Wait before retry
    }
  }
}

app.post('/api/send-sequential', async (req, res) => {
  const { users, message, accessToken, refreshToken } = req.body;

  if (!users || !message || !accessToken || !refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: users, message, accessToken, refreshToken'
    });
  }

  let currentAccessToken = accessToken;
  let currentRefreshToken = refreshToken;
  const results = [];

  for (const user of users) {
    console.log(`➡️ Sending to ${user}`);

    const result = await sendUntilSuccess({
      user,
      message,
      accessToken: currentAccessToken,
      refreshToken: currentRefreshToken
    });

    // Update tokens for next use
    currentAccessToken = result.accessToken;
    currentRefreshToken = result.refreshToken;

    results.push({ user, status: 'success' });

    await new Promise(r => setTimeout(r, 900)); // Delay before next user
  }

  res.json({
    success: true,
    tokens: {
      accessToken: currentAccessToken,
      refreshToken: currentRefreshToken
    },
    stats: {
      total: users.length,
      successful: results.length
    },
    details: results
  });
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
  console.log(`🚀 KingsChat Sequential Sender running at http://localhost:${PORT}`);
});
