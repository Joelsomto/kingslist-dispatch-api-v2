require('dotenv').config();
const axios = require('axios');
const kingsChatWebSdk = require('kingschat-web-sdk');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const he = require('he');

// Configure logger
const logDir = 'logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: path.join(logDir, 'dispatch-error.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'dispatch-combined.log') 
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => 
          `${info.timestamp} ${info.level}: ${info.message}`)
      )
    })
  ]
});

class DispatchWorker {
  constructor() {
    this.currentTokens = null;
    this.isProcessing = false;
    this.rateLimitDelay = 900;
    this.apiBaseUrl = 'https://kingslist.pro/app/default/api';
    this.dispatchStatus = {
      PENDING: 0,
      DISPATCHING: 1,
      COMPLETED: 2,
      FAILED: 3,
      INCOMPLETE: 4
    };
    this.totalDispatched = 0;
  }

  async refreshTokens(refreshToken) {
    try {
      const response = await axios.post(
        'https://kingslist-dispatch-api.onrender.com/api/refresh-token',
        { refreshToken }
      );

      if (response.data?.success) {
        this.currentTokens = {
          accessToken: response.data.accessToken,
          refreshToken: response.data.refreshToken || refreshToken
        };
        logger.info('🔄 Tokens refreshed successfully');
        return true;
      }
    } catch (error) {
      logger.error('❌ Token refresh failed:', error.message);
    }
    return false;
  }

  async sendMessage(job) {
    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    // Format message with placeholders
    function fixMojibake(str) {
      return Buffer.from(str, 'binary').toString('utf8');
    }

let message = job.message
  .replace(/<fullname>/gi, job.fullname || '')
  .replace(/<kc_username>/gi, job.username || '');

// Fix double issues: HTML entities + mojibake
message = he.decode(fixMojibake(message));


    while (attempts < maxAttempts) {
      attempts++;
      try {
        // Always use fresh tokens for each dispatch
        if (job.refresh_token) {
          await this.refreshTokens(job.refresh_token);
        }

        const tokens = this.currentTokens || {
          accessToken: job.access_token,
          refreshToken: job.refresh_token
        };

        if (!tokens.accessToken) {
          throw new Error('No access token available');
        }

        // Send the message
        const result = await kingsChatWebSdk.sendMessage({
          userIdentifier: job.kc_id,
          message: message,
          accessToken: tokens.accessToken
        });

        // Log success
        await this.saveLog({
          dmsg_id: job.dmsg_id,
          list_id: job.list_id,
          user_id: job.user_id,
          kc_id: job.kc_id,
          kc_username: job.username,
          fullname: job.fullname,
          status: 'success',
          error: null
        });

        // Increment total dispatched count
        this.totalDispatched++;
        
        logger.info(`✅ Successfully sent to ${job.kc_id}`);
        return true;

      } catch (error) {
        lastError = error;
        logger.warn(`⚠️ Attempt ${attempts} failed for ${job.kc_id}: ${error.message}`);

        // Log failure
        await this.saveLog({
          dmsg_id: job.dmsg_id,
          list_id: job.list_id,
          user_id: job.user_id,
          kc_id: job.kc_id,
          kc_username: job.username,
          fullname: job.fullname,
          status: 'failed',
          error: error.message
        });

        // Refresh tokens after each failure
        if (job.refresh_token) {
          await this.refreshTokens(job.refresh_token);
        }

        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    throw lastError || new Error(`Failed after ${maxAttempts} attempts`);
  }

  async saveLog(logData) {
    try {
      await axios.post(
        `${this.apiBaseUrl}/save_log.php`,
        logData,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.currentTokens?.accessToken || ''}`
          }
        }
      );
      logger.debug(`📝 Log saved for ${logData.kc_id}`);
    } catch (error) {
      logger.error(`Failed to save log for ${logData.kc_id}:`, error.message);
    }
  }

  async updateDispatchCount(dmsgId, additionalCount, status) {
    try {
      await axios.post(
        `${this.apiBaseUrl}/updateDispatchCount.php`,
        {
          dmsg_id: dmsgId,
          dispatch_count: additionalCount, // Now adds to existing count
          status: status
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.currentTokens?.accessToken || ''}`
          }
        }
      );
      logger.info(`📊 Added ${additionalCount} to dispatch count for ${dmsgId}, status ${status}`);
    } catch (error) {
      logger.error(`Failed to update dispatch count:`, error.message);
    }
  }

  async updateJobStatus(jobId, status, error = null) {
    try {
      await axios.post(
        `${this.apiBaseUrl}/setDispatchStatus.php`,
        { 
          id: jobId, 
          status: status, 
          error: error?.message || null 
        }
      );
      logger.info(`📝 Updated job ${jobId} to ${status}`);
    } catch (error) {
      logger.error(`Failed to update job ${jobId} status:`, error.message);
    }
  }

  async processJobs() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      logger.info('🔍 Fetching pending jobs...');
      const response = await axios.get(`${this.apiBaseUrl}/getDispatchQueue.php`);
      const jobs = response.data?.data || [];

      if (jobs.length === 0) {
        logger.info('📭 No pending jobs found');
        return;
      }

      logger.info(`📥 Found ${jobs.length} jobs to process`);

      // Update overall status to DISPATCHING
      if (jobs[0].dmsg_id) {
        await this.updateDispatchCount(jobs[0].dmsg_id, 0, this.dispatchStatus.DISPATCHING);
      }

      let successCount = 0;
      let failCount = 0;

      for (const job of jobs) {
        try {
          await this.updateJobStatus(job.id, 'processing');
          
          const success = await this.sendMessage(job);
          if (success) {
            successCount++;
          } else {
            failCount++;
          }
          
          await this.updateJobStatus(job.id, success ? 'completed' : 'failed');
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
          
        } catch (error) {
          failCount++;
          await this.updateJobStatus(job.id, 'failed', error);
        }
      }

      // Update overall status
      if (jobs[0].dmsg_id) {
        let finalStatus;
        if (failCount === 0) {
          finalStatus = this.dispatchStatus.COMPLETED;
        } else if (successCount === 0) {
          finalStatus = this.dispatchStatus.FAILED;
        } else {
          finalStatus = this.dispatchStatus.INCOMPLETE;
        }
        await this.updateDispatchCount(jobs[0].dmsg_id, successCount, finalStatus);
      }

    } catch (error) {
      logger.error('❌ Worker processing error:', error.message);
    } finally {
      this.isProcessing = false;
      logger.info(`🏁 Finished processing batch. Total dispatched: ${this.totalDispatched}`);
    }
  }

  start(interval = 60000) {
    logger.info('🚀 Starting KingsChat Dispatch Worker');
    this.processJobs();
    setInterval(() => this.processJobs(), interval);
  }
}

// Start the worker
const worker = new DispatchWorker();
worker.start();

// Handle process termination
process.on('SIGINT', () => {
  logger.info('🛑 Gracefully shutting down...');
  process.exit(0);
});











