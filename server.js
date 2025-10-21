import express from 'express';
import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const PORT = process.env.PORT || 3000;
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME;
const INSTAGRAM_PASSWORD = process.env.INSTAGRAM_PASSWORD;
const PROXY_URL = process.env.PROXY_URL; // Optional: format http://user:pass@host:port
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

// Rate limiting: in-memory store for production-lite scenarios
// Key structure: { ip: { count: number, resetAt: timestamp } }
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // Max 5 requests per minute per IP
const GLOBAL_RATE_LIMIT_MAX = 20; // Max 20 requests per minute globally

// Global request counter for rate limiting across all IPs
let globalRequestCount = 0;
let globalResetAt = Date.now() + RATE_LIMIT_WINDOW_MS;

// ============================================================================
// SESSION PERSISTENCE & ACTIVITY TRACKING
// ============================================================================

// Session store: Reuses login cookies for 24 hours to reduce login frequency
// Structure: { cookies: Array, createdAt: timestamp, loginCount: number }
let sessionStore = null;
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Activity cooldown: Enforces minimum delay between follow actions
// Prevents rapid-fire follows that trigger Instagram's spam detection
let lastFollowAction = {
  timestamp: 0,
  username: null
};
const MIN_COOLDOWN_MS = 30000; // 30 seconds minimum
const MAX_COOLDOWN_MS = 60000; // 60 seconds maximum

// Account health tracking: Monitors for Instagram blocks/bans
let accountHealth = {
  isHealthy: true,
  lastCheckAt: Date.now(),
  blockDetectedAt: null,
  consecutiveErrors: 0,
  totalBlocks: 0,
  warnings: []
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generates a random delay to mimic human behavior and avoid detection.
 * Used between actions like clicking, typing, and navigation.
 * @param {number} min - Minimum delay in milliseconds
 * @param {number} max - Maximum delay in milliseconds
 */
const randomDelay = (min = 1000, max = 3000) => {
  return new Promise(resolve => 
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  );
};

/**
 * Calculates exponential backoff delay for retry attempts.
 * Prevents hammering Instagram's servers and reduces block risk.
 * @param {number} attempt - Current retry attempt number (0-indexed)
 */
const getBackoffDelay = (attempt) => {
  return BASE_DELAY_MS * Math.pow(2, attempt);
};

/**
 * Checks if stored session is still valid (< 24 hours old).
 * Valid sessions are reused to reduce login frequency and avoid detection.
 * @returns {boolean} True if session exists and is still valid
 */
const isSessionValid = () => {
  if (!sessionStore) return false;
  
  const sessionAge = Date.now() - sessionStore.createdAt;
  const isExpired = sessionAge > SESSION_DURATION_MS;
  
  if (isExpired) {
    console.log(`[SESSION] Expired after ${Math.floor(sessionAge / 1000 / 60)} minutes. Creating new session.`);
    sessionStore = null;
    return false;
  }
  
  console.log(`[SESSION] Reusing existing session (age: ${Math.floor(sessionAge / 1000 / 60)} minutes, logins: ${sessionStore.loginCount})`);
  return true;
};

/**
 * Saves browser cookies to session store for reuse.
 * Reduces login frequency which is a major bot detection signal.
 * @param {BrowserContext} context - Playwright browser context
 */
const saveSession = async (context) => {
  const cookies = await context.cookies();
  sessionStore = {
    cookies: cookies,
    createdAt: Date.now(),
    loginCount: sessionStore ? sessionStore.loginCount + 1 : 1
  };
  console.log(`[SESSION] Session saved with ${cookies.length} cookies`);
};

/**
 * Restores saved cookies to browser context.
 * Allows bypassing login flow if session is still valid.
 * @param {BrowserContext} context - Playwright browser context
 */
const restoreSession = async (context) => {
  if (sessionStore && sessionStore.cookies) {
    await context.addCookies(sessionStore.cookies);
    console.log(`[SESSION] Restored ${sessionStore.cookies.length} cookies`);
  }
};

/**
 * Enforces cooldown period between follow actions.
 * Instagram flags accounts that follow too rapidly (bot behavior).
 * @param {string} username - Target username (for logging)
 * @returns {Promise<void>} Resolves after cooldown completes
 */
const enforceCooldown = async (username) => {
  const now = Date.now();
  const timeSinceLastAction = now - lastFollowAction.timestamp;
  
  if (lastFollowAction.timestamp === 0) {
    // First action, no cooldown needed
    lastFollowAction = { timestamp: now, username };
    return;
  }
  
  // Calculate random cooldown between 30-60 seconds
  const requiredCooldown = Math.floor(Math.random() * (MAX_COOLDOWN_MS - MIN_COOLDOWN_MS + 1)) + MIN_COOLDOWN_MS;
  
  if (timeSinceLastAction < requiredCooldown) {
    const waitTime = requiredCooldown - timeSinceLastAction;
    console.log(`[COOLDOWN] Last action: ${lastFollowAction.username} (${Math.floor(timeSinceLastAction / 1000)}s ago). Waiting ${Math.floor(waitTime / 1000)}s before following ${username}...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  } else {
    console.log(`[COOLDOWN] OK - ${Math.floor(timeSinceLastAction / 1000)}s since last action (${lastFollowAction.username})`);
  }
  
  lastFollowAction = { timestamp: Date.now(), username };
};

/**
 * Checks page content for Instagram block/ban indicators.
 * Detects various block messages and updates account health status.
 * @param {Page} page - Playwright page instance
 * @returns {Object} Health status with details
 */
const checkAccountHealth = async (page) => {
  const healthCheck = await page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const htmlContent = document.body.innerHTML.toLowerCase();
    
    // Comprehensive block detection patterns
    const blockPatterns = {
      actionBlocked: bodyText.includes('action blocked') || 
                     bodyText.includes('we restrict certain activity') ||
                     bodyText.includes('this action was blocked'),
      temporaryBan: bodyText.includes('try again later') || 
                    bodyText.includes('please wait a few minutes'),
      spamDetected: bodyText.includes('unusual activity') || 
                    bodyText.includes('spam') ||
                    bodyText.includes('automated behavior'),
      rateLimited: bodyText.includes('too many requests') ||
                   bodyText.includes('slow down'),
      accountWarning: bodyText.includes('your account') && 
                      (bodyText.includes('warning') || bodyText.includes('violation')),
      captchaChallenge: bodyText.includes('security check') ||
                        htmlContent.includes('recaptcha') ||
                        bodyText.includes('prove you\'re not a robot')
    };
    
    const isBlocked = Object.values(blockPatterns).some(detected => detected);
    
    return {
      isHealthy: !isBlocked,
      patterns: blockPatterns,
      detectedIssues: Object.keys(blockPatterns).filter(key => blockPatterns[key])
    };
  });
  
  // Update global account health
  if (!healthCheck.isHealthy) {
    accountHealth.isHealthy = false;
    accountHealth.blockDetectedAt = Date.now();
    accountHealth.totalBlocks++;
    accountHealth.consecutiveErrors++;
    accountHealth.warnings.push({
      timestamp: new Date().toISOString(),
      issues: healthCheck.detectedIssues
    });
    
    // Keep only last 10 warnings
    if (accountHealth.warnings.length > 10) {
      accountHealth.warnings.shift();
    }
    
    console.error(`[HEALTH] ⚠️ ACCOUNT BLOCK DETECTED! Issues: ${healthCheck.detectedIssues.join(', ')}`);
    console.error(`[HEALTH] Total blocks: ${accountHealth.totalBlocks}, Consecutive errors: ${accountHealth.consecutiveErrors}`);
  } else {
    // Reset consecutive errors on success
    if (accountHealth.consecutiveErrors > 0) {
      console.log(`[HEALTH] ✅ Account healthy again after ${accountHealth.consecutiveErrors} errors`);
    }
    accountHealth.consecutiveErrors = 0;
    accountHealth.isHealthy = true;
  }
  
  accountHealth.lastCheckAt = Date.now();
  return healthCheck;
};

/**
 * Sanitizes user input to prevent injection attacks.
 * Instagram usernames can only contain alphanumeric, dots, and underscores.
 * @param {string} username - The username to validate
 */
const sanitizeUsername = (username) => {
  if (!username || typeof username !== 'string') {
    return null;
  }
  // Instagram username rules: 1-30 chars, alphanumeric, dots, underscores
  const sanitized = username.trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(sanitized)) {
    return null;
  }
  return sanitized;
};

/**
 * Validates Bearer token from Authorization header.
 * Constant-time comparison to prevent timing attacks.
 * @param {string} authHeader - The Authorization header value
 */
const validateBearerToken = (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7);
  
  // Constant-time comparison to prevent timing attacks
  if (token.length !== BEARER_TOKEN.length) {
    return false;
  }
  
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ BEARER_TOKEN.charCodeAt(i);
  }
  
  return mismatch === 0;
};

/**
 * Checks and enforces per-IP rate limiting.
 * Prevents abuse from individual sources.
 * @param {string} ip - Client IP address
 */
const checkRateLimit = (ip) => {
  const now = Date.now();
  
  // Check global rate limit first
  if (now > globalResetAt) {
    globalRequestCount = 0;
    globalResetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  
  if (globalRequestCount >= GLOBAL_RATE_LIMIT_MAX) {
    return { allowed: false, message: 'Global rate limit exceeded' };
  }
  
  // Check per-IP rate limit
  const clientData = rateLimitStore.get(ip);
  
  if (!clientData || now > clientData.resetAt) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    globalRequestCount++;
    return { allowed: true };
  }
  
  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, message: 'Rate limit exceeded for IP' };
  }
  
  clientData.count++;
  globalRequestCount++;
  return { allowed: true };
};

// ============================================================================
// INSTAGRAM AUTOMATION CORE
// ============================================================================

/**
 * Launches a Playwright browser and context with appropriate settings.
 * Creates a persistent context that can store and reuse cookies.
 * Configures proxy if provided and sets up stealth parameters.
 * @returns {Object} Browser and context instances
 */
const launchBrowser = async () => {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  };
  
  // Add proxy configuration if provided (for geo-flexibility and anti-block)
  if (PROXY_URL) {
    launchOptions.proxy = {
      server: PROXY_URL
    };
  }
  
  const browser = await chromium.launch(launchOptions);
  
  // Create new context for cookie/session management
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  
  // Restore session if valid
  if (isSessionValid()) {
    await restoreSession(context);
  }
  
  return { browser, context };
};

/**
 * Performs Instagram login using stored credentials.
 * Handles 2FA detection (fails gracefully without bypass attempts).
 * Uses future-resilient selectors and waits for navigation completion.
 * If session is restored, verifies login status without re-authenticating.
 * @param {Page} page - Playwright page instance
 * @param {BrowserContext} context - Playwright context for saving session
 * @param {boolean} hasRestoredSession - Whether session cookies were restored
 */
const loginToInstagram = async (page, context, hasRestoredSession = false) => {
  try {
    // If we restored a session, check if we're already logged in
    if (hasRestoredSession) {
      console.log('[SESSION] Checking if restored session is still valid...');
      await page.goto('https://www.instagram.com/', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      await randomDelay(1000, 2000);
      
      // Check if already logged in
      const isLoggedIn = await page.evaluate(() => {
        return document.querySelector('nav') !== null || 
               document.querySelector('[aria-label="Home"]') !== null ||
               document.querySelector('a[href*="/direct/"]') !== null;
      });
      
      if (isLoggedIn) {
        console.log('[SESSION] ✅ Restored session is valid - skipping login!');
        return true;
      } else {
        console.log('[SESSION] ⚠️ Restored session expired - performing fresh login');
        sessionStore = null; // Clear invalid session
      }
    }
    
    // Perform fresh login
    console.log('[LOGIN] Performing fresh Instagram login...');
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    await randomDelay(2000, 4000);
    
    // Wait for login form to be visible - multiple selector strategy for resilience
    await page.waitForSelector('input[name="username"], input[autocomplete="username"]', {
      state: 'visible',
      timeout: 10000
    });
    
    // Type username with human-like delays between keystrokes
    await page.fill('input[name="username"]', INSTAGRAM_USERNAME);
    await randomDelay(500, 1000);
    
    // Type password with human-like delays
    await page.fill('input[name="password"]', INSTAGRAM_PASSWORD);
    await randomDelay(1000, 2000);
    
    // Click login button and wait for navigation
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]')
    ]);
    
    await randomDelay(2000, 3000);
    
    // Check for 2FA challenge (we detect but do NOT bypass per requirements)
    const is2FAPresent = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      return bodyText.includes('security code') || 
             bodyText.includes('two-factor') || 
             bodyText.includes('authentication') ||
             bodyText.includes('verify');
    });
    
    if (is2FAPresent) {
      throw new Error('2FA_CHALLENGE_DETECTED');
    }
    
    // Verify login success by checking for common post-login elements
    const isLoggedIn = await page.evaluate(() => {
      // Check if we're on the home feed or have navigation elements
      return document.querySelector('nav') !== null || 
             document.querySelector('[aria-label="Home"]') !== null ||
             window.location.pathname === '/';
    });
    
    if (!isLoggedIn) {
      throw new Error('LOGIN_FAILED');
    }
    
    console.log('[LOGIN] ✅ Login successful');
    
    // Save session cookies for reuse
    await saveSession(context);
    
    // Dismiss "Save Login Info" and "Turn on Notifications" prompts if they appear
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach(button => {
        const text = button.innerText.toLowerCase();
        if (text.includes('not now') || text.includes('cancel')) {
          button.click();
        }
      });
    });
    
    await randomDelay(1000, 2000);
    
    return true;
  } catch (error) {
    throw error;
  }
};

/**
 * Navigates to a target user's profile and attempts to follow them.
 * Implements comprehensive state detection: already following, pending, private, etc.
 * Uses resilient selectors that adapt to Instagram's frontend changes.
 * Checks account health before and after action to detect blocks.
 * @param {Page} page - Playwright page instance
 * @param {string} username - Target Instagram username
 */
const followUser = async (page, username) => {
  try {
    // Navigate to user's profile
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    await randomDelay(2000, 4000);
    
    // Check account health BEFORE attempting follow
    const healthCheckBefore = await checkAccountHealth(page);
    if (!healthCheckBefore.isHealthy) {
      return { 
        status: 'failed', 
        message: `Account blocked by Instagram: ${healthCheckBefore.detectedIssues.join(', ')}`,
        healthIssues: healthCheckBefore.detectedIssues
      };
    }
    
    // Check if profile exists (404 or "Sorry, this page isn't available")
    const pageNotFound = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      return bodyText.includes("sorry, this page isn't available") ||
             bodyText.includes("page not found") ||
             bodyText.includes("couldn't find");
    });
    
    if (pageNotFound) {
      return { status: 'notfound', message: 'Profile does not exist' };
    }
    
    // Check if we're blocked by this user
    const isBlocked = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      return bodyText.includes("no posts yet") && bodyText.includes("when") ||
             bodyText.includes("user not found");
    });
    
    if (isBlocked) {
      return { status: 'blocked', message: 'Blocked by user or user not accessible' };
    }
    
    await randomDelay(1000, 2000);
    
    // Find the follow/following button with multiple selector strategies
    // Instagram uses different selectors and button texts over time
    const buttonInfo = await page.evaluate(() => {
      // Try multiple strategies to find the follow button
      const buttons = Array.from(document.querySelectorAll('button'));
      
      // Strategy 1: Look for button with specific text
      let followButton = buttons.find(btn => {
        const text = btn.innerText.toLowerCase().trim();
        return text === 'follow' || text === 'following' || text === 'requested' || 
               text === 'follow back' || text.includes('unfollow');
      });
      
      // Strategy 2: Look for button with aria-label
      if (!followButton) {
        followButton = buttons.find(btn => {
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
          return ariaLabel.includes('follow') || ariaLabel.includes('unfollow');
        });
      }
      
      // Strategy 3: Look for button in header section
      if (!followButton) {
        const header = document.querySelector('header');
        if (header) {
          const headerButtons = Array.from(header.querySelectorAll('button'));
          followButton = headerButtons.find(btn => {
            const text = btn.innerText.toLowerCase().trim();
            return text === 'follow' || text === 'following' || text === 'requested';
          });
        }
      }
      
      if (!followButton) {
        return { found: false };
      }
      
      const buttonText = followButton.innerText.toLowerCase().trim();
      
      return {
        found: true,
        text: buttonText,
        isFollowing: buttonText === 'following' || buttonText.includes('unfollow'),
        isPending: buttonText === 'requested',
        canFollow: buttonText === 'follow' || buttonText === 'follow back'
      };
    });
    
    if (!buttonInfo.found) {
      return { status: 'failed', message: 'Could not locate follow button (possible UI change)' };
    }
    
    // Return early if already following
    if (buttonInfo.isFollowing) {
      return { status: 'alreadyfollowed', message: 'Already following this user' };
    }
    
    // Return early if request is pending (private account)
    if (buttonInfo.isPending) {
      return { status: 'privateorpending', message: 'Follow request already pending (private account)' };
    }
    
    // Click the follow button if we can follow
    if (buttonInfo.canFollow) {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const followButton = buttons.find(btn => {
          const text = btn.innerText.toLowerCase().trim();
          return text === 'follow' || text === 'follow back';
        });
        if (followButton) {
          followButton.click();
        }
      });
      
      await randomDelay(2000, 4000);
      
      // Verify the follow action succeeded by checking button state change
      const newButtonState = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const followButton = buttons.find(btn => {
          const text = btn.innerText.toLowerCase().trim();
          return text === 'following' || text === 'requested' || text.includes('unfollow');
        });
        
        if (followButton) {
          const text = followButton.innerText.toLowerCase().trim();
          return {
            success: true,
            isPrivate: text === 'requested',
            isFollowing: text === 'following' || text.includes('unfollow')
          };
        }
        
        return { success: false };
      });
      
      if (newButtonState.success) {
        // Check account health AFTER follow action to detect any blocks
        await randomDelay(1000, 2000);
        const healthCheckAfter = await checkAccountHealth(page);
        
        if (!healthCheckAfter.isHealthy) {
          return { 
            status: 'failed', 
            message: `Follow action triggered Instagram block: ${healthCheckAfter.detectedIssues.join(', ')}`,
            healthIssues: healthCheckAfter.detectedIssues
          };
        }
        
        if (newButtonState.isPrivate) {
          return { status: 'privateorpending', message: 'Follow request sent (private account)' };
        }
        if (newButtonState.isFollowing) {
          return { status: 'followed', message: 'Successfully followed user' };
        }
      }
      
      return { status: 'failed', message: 'Follow action did not complete as expected' };
    }
    
    return { status: 'failed', message: 'Unknown button state' };
    
  } catch (error) {
    throw error;
  }
};

/**
 * Main automation workflow with retry logic and exponential backoff.
 * Manages browser lifecycle, handles all error scenarios gracefully.
 * Ensures proper cleanup to prevent memory leaks.
 * Implements session persistence, activity cooldown, and health monitoring.
 * @param {string} username - Target Instagram username
 */
const automateFollow = async (username) => {
  let browser = null;
  let context = null;
  
  // ENFORCE COOLDOWN before starting (prevents rapid-fire follows)
  await enforceCooldown(username);
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Launch browser with session restoration
      const browserData = await launchBrowser();
      browser = browserData.browser;
      context = browserData.context;
      
      const page = await context.newPage();
      const hasRestoredSession = isSessionValid();
      
      // Login to Instagram (or verify restored session)
      await loginToInstagram(page, context, hasRestoredSession);
      
      // Attempt to follow the target user (includes health checks)
      const result = await followUser(page, username);
      
      // Cleanup browser before returning
      await browser.close();
      browser = null;
      context = null;
      
      // Include health status in response
      const response = {
        success: result.status === 'followed' || result.status === 'alreadyfollowed' || result.status === 'privateorpending',
        status: result.status,
        timestamp: new Date().toISOString(),
        errorDetails: result.message || undefined
      };
      
      // Add health warnings if present
      if (result.healthIssues && result.healthIssues.length > 0) {
        response.healthWarning = result.healthIssues;
        response.accountHealth = {
          isHealthy: accountHealth.isHealthy,
          totalBlocks: accountHealth.totalBlocks,
          consecutiveErrors: accountHealth.consecutiveErrors
        };
      }
      
      return response;
      
    } catch (error) {
      // Always cleanup browser on error
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
        context = null;
      }
      
      // Handle 2FA challenge explicitly (no retry, immediate fail)
      if (error.message === '2FA_CHALLENGE_DETECTED') {
        return {
          success: false,
          status: 'failed',
          timestamp: new Date().toISOString(),
          errorDetails: 'Two-factor authentication required - manual login needed'
        };
      }
      
      // On last retry, return failure
      if (attempt === MAX_RETRIES - 1) {
        return {
          success: false,
          status: 'failed',
          timestamp: new Date().toISOString(),
          errorDetails: error.message || 'Maximum retries exceeded',
          accountHealth: {
            isHealthy: accountHealth.isHealthy,
            totalBlocks: accountHealth.totalBlocks,
            consecutiveErrors: accountHealth.consecutiveErrors
          }
        };
      }
      
      // Wait before retrying with exponential backoff
      const backoffDelay = getBackoffDelay(attempt);
      console.error(`Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${backoffDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  
  // Fallback return (should never reach here)
  return {
    success: false,
    status: 'failed',
    timestamp: new Date().toISOString(),
    errorDetails: 'Unexpected error in retry logic'
  };
};

// ============================================================================
// EXPRESS MIDDLEWARE & ROUTES
// ============================================================================

/**
 * Authentication middleware - validates Bearer token on every request.
 * Runs before rate limiting to avoid processing unauthorized requests.
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!validateBearerToken(authHeader)) {
    return res.status(401).json({
      success: false,
      status: 'failed',
      timestamp: new Date().toISOString(),
      errorDetails: 'Invalid or missing Bearer token'
    });
  }
  
  next();
};

/**
 * Rate limiting middleware - enforces per-IP and global limits.
 * Prevents abuse and protects Instagram account from being flagged.
 */
const rateLimitMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateLimitResult = checkRateLimit(clientIp);
  
  if (!rateLimitResult.allowed) {
    return res.status(429).json({
      success: false,
      status: 'failed',
      timestamp: new Date().toISOString(),
      errorDetails: rateLimitResult.message
    });
  }
  
  next();
};

/**
 * Health check endpoint - used by Docker and orchestrators.
 * Returns 200 OK if service is running.
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * Account health status endpoint - returns Instagram account health metrics.
 * Provides visibility into blocks, bans, and session status.
 * Requires authentication to prevent information disclosure.
 */
app.get('/account-health', authMiddleware, (req, res) => {
  const sessionAge = sessionStore ? Math.floor((Date.now() - sessionStore.createdAt) / 1000 / 60) : null;
  const sessionExpiry = sessionStore ? Math.floor((SESSION_DURATION_MS - (Date.now() - sessionStore.createdAt)) / 1000 / 60) : null;
  
  res.status(200).json({
    accountHealth: {
      isHealthy: accountHealth.isHealthy,
      lastCheckAt: new Date(accountHealth.lastCheckAt).toISOString(),
      blockDetectedAt: accountHealth.blockDetectedAt ? new Date(accountHealth.blockDetectedAt).toISOString() : null,
      consecutiveErrors: accountHealth.consecutiveErrors,
      totalBlocks: accountHealth.totalBlocks,
      recentWarnings: accountHealth.warnings.slice(-5) // Last 5 warnings
    },
    session: {
      isActive: sessionStore !== null,
      ageMinutes: sessionAge,
      expiresInMinutes: sessionExpiry,
      loginCount: sessionStore ? sessionStore.loginCount : 0
    },
    cooldown: {
      lastActionAt: lastFollowAction.timestamp > 0 ? new Date(lastFollowAction.timestamp).toISOString() : null,
      lastActionUsername: lastFollowAction.username,
      secondsSinceLastAction: lastFollowAction.timestamp > 0 ? Math.floor((Date.now() - lastFollowAction.timestamp) / 1000) : null
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * Main follow endpoint - accepts username and triggers automation.
 * Validates input, enforces auth/rate limits, returns standardized response.
 */
app.post('/follow', authMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    
    // Validate and sanitize username
    const sanitizedUsername = sanitizeUsername(username);
    
    if (!sanitizedUsername) {
      return res.status(400).json({
        success: false,
        status: 'failed',
        timestamp: new Date().toISOString(),
        errorDetails: 'Invalid username format. Must be 1-30 alphanumeric characters, dots, or underscores.'
      });
    }
    
    // Log request (non-sensitive info only)
    console.log(`[${new Date().toISOString()}] Follow request for username: ${sanitizedUsername}`);
    
    // Execute automation
    const result = await automateFollow(sanitizedUsername);
    
    // Log result
    console.log(`[${new Date().toISOString()}] Result for ${sanitizedUsername}: ${result.status}`);
    
    // Return result with appropriate HTTP status
    const httpStatus = result.success ? 200 : 500;
    res.status(httpStatus).json(result);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Unhandled error:`, error.message);
    
    res.status(500).json({
      success: false,
      status: 'failed',
      timestamp: new Date().toISOString(),
      errorDetails: 'Internal server error'
    });
  }
});

/**
 * 404 handler - returns JSON for unknown routes.
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    status: 'failed',
    timestamp: new Date().toISOString(),
    errorDetails: 'Endpoint not found'
  });
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

/**
 * Validates required environment variables on startup.
 * Fails fast if critical configuration is missing.
 */
const validateEnvironment = () => {
  const required = ['BEARER_TOKEN', 'INSTAGRAM_USERNAME', 'INSTAGRAM_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  if (BEARER_TOKEN.length < 32) {
    console.error('BEARER_TOKEN must be at least 32 characters for security');
    process.exit(1);
  }
};

// Validate environment before starting
validateEnvironment();

// Start server
app.listen(PORT, () => {
  console.log(`Instagram Follow Automation Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Proxy configured: ${PROXY_URL ? 'Yes' : 'No'}`);
});

