require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kingsChatWebSdk = require('kingschat-web-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

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

// 🔁 Retry function with exponential backoff
async function retrySendMessage({ user, message, accessToken }, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await kingsChatWebSdk.sendMessage({
        userIdentifier: user,
        message,
        accessToken
      });
      return { success: true };
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const wait = delay * Math.pow(2, attempt - 1);

      console.warn(`⚠️ Attempt ${attempt} failed for ${user}:`, error.message || error.response?.data);

      if (isLastAttempt) {
        const detailedError = error.response?.data || error.message || 'Unknown error';
        return {
          success: false,
          error: detailedError
        };
      }

      await new Promise(res => setTimeout(res, wait));
    }
  }
}

app.post('/api/send-message', async (req, res) => {
  const { users, message, accessToken, refreshToken } = req.body;

  if (!users || !message || !accessToken || !refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: users, message, accessToken, refreshToken'
    });
  }

  let currentAccessToken = accessToken;
  let currentRefreshToken = refreshToken;

  const allResults = [];

  for (const user of users) {
    // Always refresh tokens before each send
    const newTokens = await refreshTokens(currentRefreshToken);
    if (newTokens) {
      currentAccessToken = newTokens.accessToken;
      currentRefreshToken = newTokens.refreshToken;
    } else {
      console.warn(`⚠️ Token refresh failed before message to ${user}`);
    }

    // Try sending the message with retries
    const result = await retrySendMessage({
      user,
      message,
      accessToken: currentAccessToken
    });

    if (result.success) {
      console.log(`✅ Message sent to ${user}`);
      allResults.push({ user, status: 'success' });
    } else {
      console.error(`❌ Final failure for ${user}:`, result.error);
      allResults.push({
        user,
        status: 'failed',
        error: result.error
      });

      // Refresh again after failure, just in case
      const retryTokens = await refreshTokens(currentRefreshToken);
      if (retryTokens) {
        currentAccessToken = retryTokens.accessToken;
        currentRefreshToken = retryTokens.refreshToken;
        console.log(`🔄 Token refreshed after failure for ${user}`);
      }
    }

    // Wait between sends
    await new Promise(r => setTimeout(r, 900));
  }

  const successful = allResults.filter(r => r.status === 'success');
  const failed = allResults.filter(r => r.status === 'failed');

  res.json({
    success: true,
    tokens: {
      accessToken: currentAccessToken,
      refreshToken: currentRefreshToken
    },
    stats: {
      total: users.length,
      successful: successful.length,
      failed: failed.length
    },
    details: allResults
  });
});

app.listen(PORT, () => {
  console.log(`🚀 KingsChat Bulk API ready on http://localhost:${PORT}`);
});
