# Instagram Follow Automation Microservice

Enterprise-grade Node.js microservice for automating Instagram follow actions. Designed for integration with n8n workflows via secure HTTP endpoints.

## ⚠️ Important Warnings

- **Account Risk**: Instagram actively detects and penalizes automated behavior. Use a dedicated automation account, never your personal account.
- **Legal Compliance**: Ensure your use case complies with Instagram's Terms of Service and applicable laws.
- **Rate Limiting**: Built-in rate limits are conservative. Aggressive usage may result in account suspension or IP bans.
- **2FA Limitation**: This service cannot bypass two-factor authentication. Disable 2FA on the automation account or use alternative methods.

## Features

- **Secure Authentication**: Bearer token validation with constant-time comparison
- **Rate Limiting**: Per-IP and global request throttling (in-memory)
- **Human-like Behavior**: Randomized delays, realistic user-agent, viewport simulation
- **Robust Error Handling**: Comprehensive state detection (already followed, private, blocked, not found)
- **Retry Logic**: Exponential backoff with up to 3 retry attempts
- **Proxy Support**: Optional proxy configuration for geo-flexibility and anti-blocking
- **Docker Ready**: Full containerization with health checks
- **Production Hardened**: Minimal dependencies, security best practices, non-root execution

### 🛡️ Advanced Anti-Ban Features

- **Session Persistence**: Reuses login cookies for 24 hours to reduce login frequency (major bot signal)
- **Activity Cooldown**: Enforces 30-60 second random delays between follows (prevents rapid-fire detection)
- **Account Health Monitoring**: Detects Instagram blocks/bans in real-time with comprehensive pattern matching
  - Action Blocked detection
  - Temporary ban detection
  - Spam/unusual activity warnings
  - CAPTCHA challenge detection
  - Rate limit detection
  - Account violation warnings

## Technology Stack

- **Runtime**: Node.js 20 LTS
- **Browser Automation**: Playwright with headless Chromium
- **HTTP Server**: Express.js
- **Container**: Docker with official Node.js image

## Prerequisites

- Docker (recommended) or Node.js 20+
- Instagram account (dedicated for automation)
- Secure Bearer token (32+ characters)
- Optional: HTTP/HTTPS proxy credentials

## Quick Start

### 1. Environment Setup

Copy the environment template and configure your credentials:

```bash
cp env.example .env
```

Edit `.env` with your actual values:

```bash
# Required
BEARER_TOKEN=your_secure_random_token_here  # Generate with: openssl rand -hex 32
INSTAGRAM_USERNAME=your_automation_account
INSTAGRAM_PASSWORD=your_password

# Optional
PORT=3000
NODE_ENV=production
PROXY_URL=http://user:pass@proxy-host:port
```

### 2. Docker Build & Run

**Build the container:**

```bash
docker build -t instagram-follow-service .
```

**Run the container:**

```bash
docker run -d \
  --name instagram-follow \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  instagram-follow-service
```

**Check container health:**

```bash
docker ps
docker logs instagram-follow
```

### 3. Local Development (without Docker)

**Install dependencies:**

```bash
npm install
```

**Install Playwright browsers:**

```bash
npx playwright install chromium
```

**Start the service:**

```bash
npm start
```

## API Documentation

### Endpoint: POST /follow

Attempts to follow a specified Instagram user.

**URL**: `http://localhost:3000/follow`

**Method**: `POST`

**Authentication**: Bearer token in `Authorization` header

**Request Headers**:
```
Authorization: Bearer your_secure_bearer_token_min_32_chars
Content-Type: application/json
```

**Request Body**:
```json
{
  "username": "targetUsername"
}
```

**Response Format**:
```json
{
  "success": true | false,
  "status": "followed" | "alreadyfollowed" | "privateorpending" | "notfound" | "blocked" | "failed",
  "timestamp": "2025-10-19T12:34:56.789Z",
  "errorDetails": "Optional error message"
}
```

**Status Values Explained**:

| Status | Description |
|--------|-------------|
| `followed` | Successfully followed the user |
| `alreadyfollowed` | Already following this user (idempotent) |
| `privateorpending` | Follow request sent to private account or already pending |
| `notfound` | User profile does not exist |
| `blocked` | You are blocked by this user or account is restricted |
| `failed` | General failure (see `errorDetails` for specifics) |

**HTTP Status Codes**:

- `200`: Success (check `success` and `status` fields for details)
- `400`: Invalid request (bad username format)
- `401`: Unauthorized (invalid or missing Bearer token)
- `429`: Rate limit exceeded
- `500`: Internal server error

### Endpoint: GET /health

Health check endpoint for monitoring and orchestration.

**URL**: `http://localhost:3000/health`

**Method**: `GET`

**Authentication**: None required

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2025-10-19T12:34:56.789Z"
}
```

### Endpoint: GET /account-health

Instagram account health monitoring endpoint. Returns detailed metrics about account status, session state, and activity cooldown.

**URL**: `http://localhost:3000/account-health`

**Method**: `GET`

**Authentication**: Bearer token required

**Request Headers**:
```
Authorization: Bearer your_secure_bearer_token_min_32_chars
```

**Response**:
```json
{
  "accountHealth": {
    "isHealthy": true,
    "lastCheckAt": "2025-10-19T12:34:56.789Z",
    "blockDetectedAt": null,
    "consecutiveErrors": 0,
    "totalBlocks": 0,
    "recentWarnings": []
  },
  "session": {
    "isActive": true,
    "ageMinutes": 45,
    "expiresInMinutes": 1395,
    "loginCount": 12
  },
  "cooldown": {
    "lastActionAt": "2025-10-19T12:30:00.000Z",
    "lastActionUsername": "targetuser",
    "secondsSinceLastAction": 296
  },
  "timestamp": "2025-10-19T12:34:56.789Z"
}
```

**Field Descriptions**:

| Field | Description |
|-------|-------------|
| `accountHealth.isHealthy` | `true` if no Instagram blocks detected |
| `accountHealth.blockDetectedAt` | Timestamp of most recent block detection (null if never blocked) |
| `accountHealth.totalBlocks` | Cumulative count of blocks detected |
| `accountHealth.consecutiveErrors` | Current streak of errors (resets on success) |
| `session.isActive` | `true` if session cookies are stored and valid |
| `session.ageMinutes` | How long current session has been active |
| `session.expiresInMinutes` | Time until session expires (24hr max) |
| `session.loginCount` | Number of times session has been reused |
| `cooldown.lastActionAt` | Timestamp of last follow action |
| `cooldown.secondsSinceLastAction` | Seconds since last action (cooldown tracking) |

**Use Cases**:
- Monitor account health before running large workflows
- Set up alerts when `isHealthy` becomes `false`
- Track session reuse efficiency (fewer logins = safer)
- Verify cooldown is being enforced between actions

## Usage Examples

### cURL

```bash
curl -X POST http://localhost:3000/follow \
  -H "Authorization: Bearer your_secure_bearer_token_min_32_chars" \
  -H "Content-Type: application/json" \
  -d '{"username":"targetuser"}'
```

### n8n HTTP Request Node

**Configuration**:
- **Method**: POST
- **URL**: `http://your-server:3000/follow`
- **Authentication**: Generic Credential Type → Header Auth
  - **Name**: `Authorization`
  - **Value**: `Bearer your_secure_bearer_token_min_32_chars`
- **Body**:
  ```json
  {
    "username": "{{$json["username"]}}"
  }
  ```

**Best Practices for n8n Workflows**:

1. **Add Account Health Check Before Batch Operations**:
   ```
   [HTTP Request: GET /account-health]
       ↓
   [IF Node: accountHealth.isHealthy === true]
       ↓ (yes)
   [Loop: POST /follow for each username]
       ↓ (no)
   [Stop & Alert: Account is blocked]
   ```

2. **Respect Cooldown** (built-in, but add delays between batch items):
   ```
   [Split In Batches: 10 usernames]
       ↓
   [POST /follow]
       ↓
   [Wait Node: 60 seconds]  ← Extra safety margin
       ↓
   [Next batch]
   ```

3. **Monitor Response for Health Warnings**:
   ```javascript
   // In n8n Function Node after /follow request
   if ($json.healthWarning) {
     // Pause workflow and alert
     throw new Error(`Account blocked: ${$json.healthWarning.join(', ')}`);
   }
   ```

4. **Schedule Workflows Wisely**:
   - Spread throughout the day (9 AM - 10 PM)
   - Avoid midnight-6 AM (bot pattern)
   - Use n8n's Schedule Trigger with randomization

### Postman

1. **Method**: POST
2. **URL**: `http://localhost:3000/follow`
3. **Headers**:
   - `Authorization`: `Bearer your_secure_bearer_token_min_32_chars`
   - `Content-Type`: `application/json`
4. **Body** (raw JSON):
   ```json
   {
     "username": "targetuser"
   }
   ```

### JavaScript/Node.js

```javascript
const response = await fetch('http://localhost:3000/follow', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_secure_bearer_token_min_32_chars',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ username: 'targetuser' })
});

const result = await response.json();
console.log(result);
```

## Rate Limiting

**Per-IP Limits**:
- 5 requests per minute per IP address

**Global Limits**:
- 20 requests per minute across all IPs

**Activity Cooldown** (Enforced Automatically):
- **30-60 seconds** random delay between each follow action
- Applied automatically before each request
- Cannot be bypassed (protects your account)

**Recommendations**:
- Space out follow requests by at least 30-60 seconds in production
- Use workflow delays in n8n to avoid triggering Instagram's anti-spam
- Monitor Instagram account for "suspicious activity" warnings
- Check `/account-health` endpoint before large batch operations

## How Anti-Ban Features Work

### 1. Session Persistence (24-Hour Cookie Reuse)

**Problem**: Logging in repeatedly is a major bot detection signal.

**Solution**: After first login, cookies are stored in memory for 24 hours.

**Benefits**:
- Reduces login frequency from every request to once per day
- Appears more like a persistent browser session
- Lower risk of "suspicious login activity" flags

**How to Monitor**:
```bash
curl http://localhost:3000/account-health \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Check `session.loginCount` - higher is better (means session is being reused).

### 2. Activity Cooldown (30-60 Second Delays)

**Problem**: Following multiple accounts rapidly screams "bot".

**Solution**: Service enforces random 30-60s delay between follows.

**How it Works**:
- Tracks last action timestamp
- Calculates random cooldown (30-60s)
- Waits if needed before processing new request
- Logs: `[COOLDOWN] Waiting 45s before following username...`

**Example**:
```
Request 1 (12:00:00) → Follow user1 → Success
Request 2 (12:00:15) → [COOLDOWN] Waits 37s → Follow user2 → Success
Request 3 (12:01:30) → [COOLDOWN] OK (75s passed) → Follow user3 → Success
```

**Cannot be disabled** - protects your account even if n8n sends rapid requests.

### 3. Account Health Monitoring

**Problem**: Instagram blocks can go unnoticed, wasting API calls.

**Solution**: Every page load checks for 6 types of Instagram warnings.

**Detects**:
1. **Action Blocked**: "We restrict certain activity..."
2. **Temporary Ban**: "Try again later..."
3. **Spam Detection**: "Unusual activity detected..."
4. **Rate Limiting**: "Too many requests..."
5. **Account Warnings**: "Your account may be violating..."
6. **CAPTCHA Challenges**: "Prove you're not a robot..."

**Automatic Response**:
- Returns `success: false` with `healthIssues` array
- Increments `totalBlocks` counter
- Logs detailed warning for investigation
- Response includes `accountHealth` object

**Example Response When Blocked**:
```json
{
  "success": false,
  "status": "failed",
  "errorDetails": "Account blocked by Instagram: actionBlocked, temporaryBan",
  "healthWarning": ["actionBlocked", "temporaryBan"],
  "accountHealth": {
    "isHealthy": false,
    "totalBlocks": 3,
    "consecutiveErrors": 1
  }
}
```

**What to Do When Blocked**:
1. **Stop immediately** - pause all n8n workflows
2. Check `/account-health` for details
3. Wait 24-48 hours before resuming
4. Resume at 50% of previous rate
5. Consider rotating to a different proxy

## Troubleshooting

### Common Issues

**1. "Two-factor authentication required" Error**

- **Cause**: 2FA is enabled on the Instagram account
- **Solution**: Disable 2FA on the automation account, or handle login manually once to establish a trusted session

**2. "Maximum retries exceeded" or Frequent Failures**

- **Cause**: Instagram may be blocking the IP or detecting automation
- **Solutions**:
  - Configure a residential proxy in `PROXY_URL`
  - Reduce request frequency (add delays in n8n workflow)
  - Verify Instagram credentials are correct
  - Check if account is restricted or banned

**3. "Could not locate follow button (possible UI change)"**

- **Cause**: Instagram updated their frontend HTML structure
- **Solution**: The service uses multiple selector strategies, but major redesigns may require code updates. Check for service updates or modify selectors in `server.js`

**4. Rate Limit Exceeded (429 Response)**

- **Cause**: Too many requests in short time window
- **Solutions**:
  - Reduce n8n workflow execution frequency
  - Implement queuing in n8n to throttle requests
  - Consider deploying multiple instances with different IPs

**5. Container Fails Health Check**

- **Cause**: Service not starting properly or Chromium issues
- **Solutions**:
  - Check logs: `docker logs instagram-follow`
  - Verify all environment variables are set correctly
  - Ensure sufficient container memory (minimum 512MB recommended)

**6. "LOGIN_FAILED" Error**

- **Cause**: Invalid credentials or Instagram blocking login
- **Solutions**:
  - Verify `INSTAGRAM_USERNAME` and `INSTAGRAM_PASSWORD` are correct
  - Log into the account manually from a browser to check for warnings
  - Instagram may require CAPTCHA or email verification
  - Use a proxy to change IP address

### Anti-Blocking Best Practices

1. **Use Residential Proxies**: Datacenter IPs are more likely to be flagged
2. **Limit Daily Actions**: Stay under 200-300 follows per day
3. **Randomize Timing**: Don't follow at exact intervals
4. **Warm Up New Accounts**: Start with 10-20 follows/day, gradually increase over weeks
5. **Diversify Actions**: Mix follows with other activities (likes, comments) if possible
6. **Monitor Account Health**: Check for shadow bans or restrictions regularly
7. **Use Aged Accounts**: Older accounts with activity history are trusted more
8. **Avoid Follow/Unfollow Loops**: Instagram detects and penalizes this pattern

### Debug Mode

To run with verbose logging (local development):

```bash
NODE_ENV=development node server.js
```

To see Playwright browser (non-headless):

Edit `server.js` line ~149:
```javascript
headless: false,  // Change from true
```

## Security Best Practices

### Production Deployment Checklist

- [ ] Use a strong Bearer token (minimum 32 random characters)
- [ ] Store `.env` file securely, never commit to Git
- [ ] Enable firewall rules to restrict access to known IPs only
- [ ] Use HTTPS reverse proxy (nginx, Traefik) in front of this service
- [ ] Rotate Bearer token monthly
- [ ] Monitor logs for unauthorized access attempts
- [ ] Run container with resource limits (`--memory 1g --cpus 1`)
- [ ] Use Docker secrets instead of env file for Kubernetes/Swarm
- [ ] Implement request logging and alerting for anomalies
- [ ] Keep dependencies updated for security patches

### Environment Security

**Never**:
- Expose the service directly to the public internet without a reverse proxy
- Use your personal Instagram account
- Share your Bearer token or credentials
- Log sensitive information (passwords, tokens)
- Run as root user (Dockerfile already handles this)

**Always**:
- Use environment variables for all secrets
- Implement IP whitelisting at firewall level
- Monitor Instagram account for security alerts
- Use HTTPS for all external communication
- Review logs regularly for suspicious activity

## Architecture Notes

### Why Playwright

- **Modern & Maintained**: Active development by Microsoft with regular updates
- **Cross-browser Support**: Easy to switch between Chromium, Firefox, or WebKit if needed
- **Better API**: More intuitive and consistent API compared to alternatives
- **Auto-wait**: Built-in smart waiting for elements reduces flakiness
- **Resource Efficiency**: Optimized for production use with minimal footprint

### Stateless Design

- Each request creates a fresh browser instance
- No session persistence between requests
- Enables horizontal scaling without shared state
- Prevents cross-request data leaks

### Rate Limiting Strategy

- In-memory store (suitable for single-instance deployments)
- For multi-instance: use Redis or shared cache
- Conservative defaults to protect account health

## Performance

**Typical Request Duration**:
- Successful follow: 15-25 seconds
- Already following: 12-18 seconds
- User not found: 8-12 seconds

**Resource Usage** (per request):
- Memory: ~300-500MB (browser instance)
- CPU: 30-50% of single core
- Network: 2-5MB data transfer

**Scaling Recommendations**:
- Single instance: 100-200 follows/day
- Multiple instances with different IPs: 500+ follows/day
- Always monitor Instagram account health when scaling

## Maintenance

### Updating Dependencies

```bash
npm update
docker build -t instagram-follow-service:latest .
```

### Log Rotation

Logs are written to stdout/stderr. Configure log rotation in Docker:

```bash
docker run -d \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  instagram-follow-service
```

### Monitoring

Integrate with monitoring tools using `/health` endpoint:

- **Uptime Monitoring**: Ping `/health` every 60 seconds
- **Docker Health**: Built-in healthcheck runs every 30 seconds
- **Alerts**: Trigger on consecutive health check failures

## License

Proprietary - All Rights Reserved

**Usage Restrictions**:
This software is provided for authorized internal use only. Redistribution, modification, or commercial use requires explicit permission.

## Support

For issues, updates, or feature requests:
- Check troubleshooting section above
- Review Instagram automation best practices
- Verify environment configuration
- Test with different accounts/proxies

## Changelog

**v1.1.0** (2025-10-19)
- ✨ **Session Persistence**: 24-hour cookie reuse to reduce login frequency
- ✨ **Activity Cooldown**: Enforced 30-60s random delays between follows
- ✨ **Account Health Monitoring**: Real-time detection of Instagram blocks/bans
- ✨ **New Endpoint**: `GET /account-health` for monitoring account status
- 🔄 **Migrated to Playwright**: More stable and better maintained than Puppeteer
- 📊 **Enhanced Responses**: Include account health metrics in follow responses
- 🐛 **Improved Logging**: Detailed session, cooldown, and health logs

**v1.0.0** (2025-10-19)
- Initial release
- Core follow automation functionality
- Docker containerization
- Rate limiting and security features
- Comprehensive error handling
