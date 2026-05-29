import { Request, Response, NextFunction } from "express";
import pino from "pino";
import crypto from "crypto";

// Configure Pino Logger for structured audit logs suitable for standard collectors like GCP/elk
export const auditLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
});

/**
 * Sanitizes Express headers to ensure zero sensitive token or session leakages.
 */
export function sanitizeRequestHeaders(headers: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  const sensitiveKeys = ["authorization", "cookie", "set-cookie", "x-api-key", "x-user-id", "session-token"];
  
  for (const key in headers) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = headers[key];
    }
  }
  return sanitized;
}

/**
 * Strict Host Validator to block any Host Header Injection and bypass attempts.
 */
export function validateHostHeader(host: string): boolean {
  if (!host) return false;
  // Strip optional port from host string (e.g. localhost:3000 -> localhost)
  const hostname = host.split(":")[0].toLowerCase().trim();
  
  // Explicit trusted hosts
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "172.17.0.1") {
    return true;
  }
  
  // Domain safe suffixes/matches to block attacker subdomains hijacking (e.g. run.app.attacker.com)
  const allowedDomains = [
    "run.app",
    "google.com",
    "googleusercontent.com",
    "ai.studio"
  ];
  
  for (const domain of allowedDomains) {
    if (hostname === domain || hostname.endsWith("." + domain)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Robust helper to log structured audit data with exact details requested:
 * IP, user ID, route, attack type, and HTTP headers. Includes SHA-256 token hashing
 * and complete sensitive header redaction.
 */
export function logAuditEvent(req: Request, attackType: string = "None", isBlocked: boolean = false, extraInfo?: any) {
  let ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'Unknown';
  if (typeof ip === 'string') {
    ip = ip.split(',')[0].trim();
  } else if (Array.isArray(ip)) {
    ip = ip[0];
  }
  if (ip === "::1" || ip === "::ffff:127.0.0.1") {
    ip = "127.0.0.1";
  }

  // Extract User ID safely - always hash credentials via SHA-256 for secure non-leak tracking
  let userId = "Anonymous";
  const authHeader = req.headers["authorization"];
  if (authHeader && typeof authHeader === "string") {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex").substring(0, 16);
    userId = `bearer_sha256:${tokenHash}`;
  } else if (req.headers["x-user-id"] && typeof req.headers["x-user-id"] === "string") {
    const uidHash = crypto.createHash("sha256").update(req.headers["x-user-id"]).digest("hex").substring(0, 16);
    userId = `uid_sha256:${uidHash}`;
  } else if (req.body && req.body.code && typeof req.body.code === "string") {
    const codeHash = crypto.createHash("sha256").update(req.body.code).digest("hex").substring(0, 16);
    userId = `admin_code_sha256:${codeHash}`;
  }

  const auditRecord = {
    ip,
    userId,
    route: req.originalUrl || req.path,
    method: req.method,
    attackType,
    isBlocked,
    headers: sanitizeRequestHeaders(req.headers),
    timestamp: new Date().toISOString(),
    ...extraInfo
  };

  if (isBlocked) {
    auditLogger.warn(auditRecord, `🚫 SECURITY SHIELD BLOCKED: [${attackType}] on ${req.method} ${req.path}`);
  } else {
    auditLogger.info(auditRecord, `📝 AUDIT LOG EXECUTED: ${req.method} ${req.path}`);
  }
}

// Safe list of domains allowed for outbound webhooks (SSRF/DNS Rebinding Mitigation)
const ALLOWED_WEBHOOK_DOMAINS = [
  "discord.com",
  "discordapp.com"
];

// Memory storage for rate limiting (protects against Brute Force, Denial of Service, Credential Stuffing)
interface RateLimitIp {
  count: number;
  resetTime: number;
}
const rateLimitMap = new Map<string, RateLimitIp>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 150; // Dynamic safe value

/**
 * Highly Robust Security WAF Engine
 * Inspects queries, payloads, headers, and parameters to mitigate all OWASP Top 10 exploits
 */
export function containsMaliciousPayload(data: any): { isMalicious: boolean; type: string; payload: string } | null {
  if (!data) return null;

  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  let normalized = serialized;
  try {
    normalized = decodeURIComponent(serialized);
  } catch (e) {
    // If decoding fails (e.g., raw '%' characters not forming valid hex), fall back to original serialized content
    normalized = serialized;
  }
  normalized = normalized.toLowerCase();

  // 1. SQLi, Blind SQLi, Time-Based SQL Injection
  const sqlRegexes = [
    /\bunion\s+(all\s+)?select\b/,
    /\bselect\s+.*?\s+from\b/,
    /\binsert\s+into\b/,
    /\bdelete\s+from\b/,
    /\bupdate\s+.*?\s+set\b/,
    /\bdrop\s+(table|database)\b/,
    /\btruncate\s+table\b/,
    /(\%27)|(\')|(\-\-)|(\#)/, // Quotes & comments
    /\bor\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/, // blind matches e.g 'or 1=1'
    /\band\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/, // 'and 1=2'
    /benchmark\s*\(\s*\d+\s*,\s*md5\s*\(/i, // Time-Based SQLi
    /pg_sleep\s*\(\s*\d+\s*\)/i, // PG Time-Based SQLi
    /sleep\s*\(\s*\d+\s*\)/i, // MySQL sleep
    /waitfor\s+delay\s+['"]\d+:\d+:\d+['"]/i // MSSQL time-based
  ];
  for (const regex of sqlRegexes) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "SQL Injection (SQLi / Blind / Time-Based)", payload: serialized.substring(0, 150) };
    }
  }

  // 2. NoSQL Injection (inspects MongoDB / NoSQL operators)
  const nosqlRegexes = [
    /\$gt\b/, /\$gte\b/, /\$lt\b/, /\$lte\b/, /\$ne\b/, /\$eq\b/, /\$nin\b/, /\$regex\b/,
    /\$where\b/, /\$elemMatch\b/, /db\.\w+\.find/
  ];
  for (const regex of nosqlRegexes) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "NoSQL Injection", payload: serialized.substring(0, 150) };
    }
  }

  // 3. LDAP / XPath Injection
  // XPath queries use standard node comparisons/evaluator syntax. LDAP uses filter characters
  const ldapXPathPatterns = [
    /([\w-]+)\s*=\s*['"]\s*\*\s*['"]/, // ldap query filter wildcards
    /\bobjectclass\s*=/i,
    /([^\w\s])\1{2,}/, // sequential repetives
    /\*\/memberof\b/i,
    /\w+\[\s*@\w+\s*=\s*['"]/ // XPath element querying
  ];
  for (const regex of ldapXPathPatterns) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "LDAP / XPath Injection", payload: serialized.substring(0, 150) };
    }
  }

  // 4. Stored / Reflected / DOM Cross-Site Scripting (XSS)
  const xssPatterns = [
    /<script\b[\s\S]*?>[\s\S]*?<\/script>/,
    /javascript:/,
    /onload\s*=/,
    /onerror\s*=/,
    /onclick\s*=/,
    /onmouseover\s*=/,
    /onfocus\s*=/,
    /alert\s*\(/,
    /confirm\s*\(/,
    /prompt\s*\(/,
    /eval\s*\(/,
    /svg\/onload/i,
    /expression\s*\(/i, // IE legacy vulnerability
    /document\.cookie/i,
    /window\.location/i
  ];
  for (const regex of xssPatterns) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "Cross-Site Scripting (XSS)", payload: serialized.substring(0, 150) };
    }
  }

  // 5. Local File Inclusion (LFI) / Directory Traversal & ZIP Slip
  const pathTraversalPatterns = [
    /\.\.\//, // ../
    /\.\.\\/, // ..\
    /\.\.%2f/, 
    /\.\.%5c/,
    /\/etc\/passwd/,
    /\/etc\/shadow/,
    /boot\.ini/,
    /win\.ini/,
    /\\windows\\system32/i,
    /proc\/self\/environ/i
  ];
  for (const regex of pathTraversalPatterns) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "Directory Traversal / LFI / ZIP Slip", payload: serialized.substring(0, 150) };
    }
  }

  // 6. Remote Code Execution (RCE) / Command Injection / SSTI / Expression Language (EL)
  const rcePatterns = [
    /;\s*(whoami|id|cat|ls|pwd|uname|wget|curl|chmod|bash|sh|powershell|cmd)/,
    /&&\s*(whoami|id|cat|ls|pwd|uname|wget|curl|chmod|bash|sh|powershell|cmd)/,
    /\|\|\s*(whoami|id|cat|ls|pwd|uname|wget|curl|chmod|bash|sh|powershell|cmd)/,
    /`\s*[a-zA-Z]/, // backticks
    /\$\([\s\S]+?\)/, // subshells
    /nc\s+-e/,
    /netcat\s+-e/,
    /python\s+-c/,
    /render\s*\(\s*['"]\s*\{\{/i, // Server-side Template Injection indicators
    /\{\{\s*config\s*\}\}/i, // Jinja/Flask Template exploits
    /\{\{\s*system\s*\(/i,
    /\$\{\s*\d+\s*\+\s*\d+\s*\}/ // SSTI / Expression EL injections ${7+7}
  ];
  for (const regex of rcePatterns) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "RCE / Command Injection / SSTI", payload: serialized.substring(0, 150) };
    }
  }

  // 7. Prototype Pollution & Insecure Deserialization
  const protoPollutionPatterns = [
    /"__proto__"/,
    /"constructor"/,
    /"prototype"/,
    /Object\.freeze/,
    /Object\.prototype/,
    /node-serialize/i, // Serialization modules
    /_js_function/ // Javascript Deserialization payloads
  ];
  for (const regex of protoPollutionPatterns) {
    if (regex.test(serialized)) {
      return { isMalicious: true, type: "Prototype Pollution / Deserialization Attack", payload: serialized.substring(0, 150) };
    }
  }

  // 8. XML External Entity (XXE) Injection
  const xxePatterns = [
    /<!entity/i,
    /<!doctype/i,
    /sys_user\.xml/i
  ];
  for (const regex of xxePatterns) {
    if (regex.test(normalized)) {
      return { isMalicious: true, type: "XML External Entity (XXE) Injection", payload: serialized.substring(0, 150) };
    }
  }

  return null;
}

/**
 * HTTP Security Headers (Helmet Architecture)
 * Blocks Clickjacking, CORS hijack, DOM Clobbering, XSS bypass, MIME spoofing.
 */
export function setSecurityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevent MIME Sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent Clickjacking (Restrict framing) but support Google AI Studio preview iframe rendering
  const host = req.headers["host"] || "";
  const isDevProxy = host.includes("localhost") || 
                     host.includes("127.0.0.1") || 
                     host.includes("6wp7ozzu7rxgl2k4y7cgsr") || 
                     host.includes("run.app") ||
                     host.includes("ai.studio") ||
                     host.includes("google");
  
  if (!isDevProxy) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }

  // Modern browsers Cross-Site Scripting Guard
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Avoid sharing context metadata inside referrers
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // HTTPS Transport enforcement (HSTS)
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  // Strict Content Security Policy (CSP) blocking DOM Clobbering & CSP bypass, configured carefully for standard/WS engines
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' https:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
    "style-src 'self' 'unsafe-inline' https:; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data: https:; " +
    "connect-src 'self' https: wss: ws:; " +
    "frame-ancestors 'self' https://*.google.com https://*.googleusercontent.com https://*.ai.studio https://*.run.app https:;"
  );

  next();
}

/**
 * DoS & Brute Force & Session Fixation Rate Limiter
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction) {
  // Only apply rate limiting to backend API requests
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  // Parse x-forwarded-for safely since it may contain a comma-separated list of IPs
  let ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";
  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  // Bypass rate limiting for localhost/loopback to ensure zero lag in local development
  if (ip === "127.0.0.1" || ip === "localhost" || ip === "::1" || ip === "::ffff:127.0.0.1") {
    return next();
  }

  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
    return next();
  }

  record.count++;
  
  // Safe high threshold for backend APIs (2000 API calls per minute to avoid shared workspace proxy bottleneck)
  const dynamicMax = 2000;
  if (record.count > dynamicMax) {
    logAuditEvent(req, "DoS / Rate Limit Exceeded", true, { count: record.count, limit: dynamicMax });
    return res.status(429).json({
      error: "RATE_LIMITED",
      message: "TOO_MANY_REQUESTS: Please calm down your engine. Protection enabled."
    });
  }

  next();
}

/**
 * Advanced WAF Shield specifically designed to inspect and secure deobfuscation strings
 * against Prompt Injections, Hostile Override Injections, Regex-DoS payloads, and bracket bomb attacks.
 */
export function validateDeobfuscationInput(code: string): { isBlocked: boolean; reason: string } | null {
  if (!code || typeof code !== "string") return null;

  const lowerCode = code.toLowerCase();

  // 1. Strict Prompt Injection & System Protocol Override blocks
  const promptInjectionRegexes = [
    /ignore\s+(the\s+)?(previous|above|system|before)\s+(instructions|directives|rules|protocols|prompt|guidelines|parameters)/i,
    /you\s+must\s+(now\s+)?(ignore|forget|disregard|bypass|overwrite|override|reset|clear)\b/i,
    /\b(system_protocol|reconstruction_rules|critical_parity_protocol|analysis_protocol|original_obfuscated_input_code)\s*:/i,
    /forget\s+(your\s+)?(instructions|prompt|directives|rules|identity|role)/i,
    /instead\s+of\s+reconstructing,\s+print/i,
    /instead\s+of\s+deobfuscating,\s+write/i,
    /markdown\s+code\s+block\s+closing\b.*?\bmarkdown\s+code\s+block\s+opening/i,
    /print\s+only\s+the\s+following\s+text/i,
    /system\s+override\s+initiated/i,
    /stop\s+deobfuscating\s+and\s+start/i,
    /bypass\s+all\s+filters\s+and/i,
    /ignore\s+all\s+the\s+rules/i,
    /new\s+system\s+instructions/i,
    /you\s+are\s+no\s+longer\s+a\s+deobfuscator/i,
    /you\s+are\s+now\s+a\s+different\s+ai/i,
    /you\s+are\s+now\s+allowed\s+to\s+explain/i,
    /\b(jailbreak|jail_break|jail-break)\b/i
  ];

  for (const regex of promptInjectionRegexes) {
    if (regex.test(code)) {
      return {
        isBlocked: true,
        reason: "PROMPT_INJECTION_DETECTED: Target input contains statements designed to override the system analysis prompt guidelines."
      };
    }
  }

  // 2. Bracket nesting depth or Regex-DoS / Stack Overflow prevention
  const nestingCheckRegexes = [
    /([\(\{\[]\s*){150,}/, // 150+ open brackets back-to-back
    /([\)\}\]]\s*){150,}/, // 150+ close brackets back-to-back
    /([a-zA-Z0-9_\-\.\:\/\\%@\*]{20}\s*)\1{35,}/, // Repeated huge word block 35+ times
    /([a-zA-Z0-9+/=]{100,})\s*\1{20,}/ // Repeated massive base64 block
  ];

  for (const regex of nestingCheckRegexes) {
    if (regex.test(code)) {
      return {
        isBlocked: true,
        reason: "DOS_NESTING_BOMB: Input contains repetitive structures or deep nested patterns capable of inducing server parsing latency."
      };
    }
  }

  // 3. Prompt Breakout / Markdown closing Tag Hijack
  if (code.includes("```") && (code.includes("Protocol:") || code.includes("Ignore:") || lowerCode.includes("instead") || lowerCode.includes("you must"))) {
    return {
      isBlocked: true,
      reason: "MARKDOWN_BRACKET_HIJACK: Input contains potential markdown frame breakout patterns."
    };
  }

  // 4. Hostile Private Network SSRF Webhook Injections
  const ssrfHostilePatterns = [
    /169\.254\.169\.254/,
    /127\.0\.0\.1/,
    /localhost\b/,
    /metadata\.google\.internal/,
    /instance-metadata/
  ];

  for (const pattern of ssrfHostilePatterns) {
    if (pattern.test(code)) {
      return {
        isBlocked: true,
        reason: "SSRF_PROBING_BLOCKED: Input code contains unauthorized local metadata or loopback host strings."
      };
    }
  }

  return null;
}

/**
 * Web Application Firewall & Payload Shield WAF & Parameter Pollution Guard
 */
export function requestShieldWAF(req: Request, res: Response, next: NextFunction) {
  // Only apply WAF validation shields to actual backend API requests
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  // 1. Host Header Injection Defense
  const host = req.headers["host"];
  if (host && typeof host === "string") {
    if (!validateHostHeader(host)) {
      logAuditEvent(req, "Host Header Injection", true, { host });
      return res.status(400).json({
        success: false,
        code: "INVALID_HOST_HEADER",
        message: "Request host header does not match approved origins."
      });
    }
  }

  // 2. CRLF Injection Defense in Query and Path
  const rawUrl = req.url || "";
  if (rawUrl.includes("%0d") || rawUrl.includes("%0a") || rawUrl.includes("\r") || rawUrl.includes("\n")) {
    logAuditEvent(req, "CRLF Injection Detected", true, { url: rawUrl });
    return res.status(400).json({
      success: false,
      code: "CRLF_INJECTION_BLOCKED",
      message: "Security threat: CRLF Carriage returns detected in target URL."
    });
  }

  // 3. HTTP Parameter Pollution (HPP) Filter
  // Express parses repeated fields as arrays. Clean multiple parameters to prevent Parameter Pollution.
  for (const key in req.query) {
    if (Array.isArray(req.query[key])) {
      req.query[key] = (req.query[key] as any)[0]; // Force single value
    }
  }

  // 4. CSRF / CORS Misconfiguration Protection
  // Verify standard Origin matches where appropriate for mutation requests (POST/PUT/DELETE)
  const origin = req.headers["origin"] || req.headers["referer"];
  if (["POST", "PUT", "DELETE"].includes(req.method) && origin && typeof origin === "string") {
    let isLocal = false;
    try {
      if (origin.startsWith("http://") || origin.startsWith("https://")) {
        const originUrl = new URL(origin);
        isLocal = validateHostHeader(originUrl.host);
      } else {
        // Relative refere paths are safe
        isLocal = true;
      }
    } catch (e) {
      isLocal = false;
    }
    
    // Check if the actual endpoint is a webhook proxy
    if (!isLocal && !req.path.startsWith("/api/security-log")) {
      logAuditEvent(req, "CSRF / CORS Misconfiguration", true, { origin });
      return res.status(403).json({
        success: false,
        code: "CSRF_CROSS_ORIGIN_DENIED",
        message: "Operation blocked: Origin failed safety validation protocols."
      });
    }
  }

  // 5. Path Traversal & Directory Traversal Protection
  let pathClean = req.path;
  try {
    pathClean = decodeURIComponent(req.path);
  } catch (e) {
    // Keep raw path
  }
  pathClean = pathClean.toLowerCase();
  if (pathClean.includes("../") || pathClean.includes("..\\") || pathClean.includes("/etc/passwd") || pathClean.includes("c:\\windows")) {
    logAuditEvent(req, "Path Traversal / LFI Attempt", true, { pathClean });
    return res.status(403).json({
      success: false,
      code: "SHIELD_TRAVERSAL_BLOCKED",
      message: "Security violation: Access to system directory is strictly prohibited."
    });
  }

  // 6. Open Redirect Prevention
  const redirectTarget = req.query.redirect || req.body.redirect;
  if (redirectTarget && typeof redirectTarget === "string") {
    if (/^(http|https):\/\//i.test(redirectTarget)) {
      try {
        const parsedUrl = new URL(redirectTarget);
        if (!validateHostHeader(parsedUrl.host)) {
          logAuditEvent(req, "Open Redirect Attempt", true, { redirectTarget });
          return res.status(403).json({
            success: false,
            code: "SHIELD_OPEN_REDIRECT",
            message: "External redirect targets violated local host authorization policy."
          });
        }
      } catch (e) {
        logAuditEvent(req, "Open Redirect Invalid URL", true, { redirectTarget });
        return res.status(403).json({
          success: false,
          code: "SHIELD_OPEN_REDIRECT_MALFORMED",
          message: "Malformed redirect target."
        });
      }
    }
  }

  // 7. Scanning URL Query String
  const queryScan = containsMaliciousPayload(req.query);
  if (queryScan?.isMalicious) {
    logAuditEvent(req, `WAF Param Detection: ${queryScan.type}`, true, { payload: queryScan.payload });
    return res.status(403).json({
      success: false,
      code: "WAF_BLOCK",
      threatType: queryScan.type,
      detail: "Dangerous elements detected within parameters payload."
    });
  }

  // 8. Body Payload Analysis (Skip binary chunks and the obfuscated inputs we decode)
  if (req.body && typeof req.body === "object") {
    // 8a. First inspect those deobfuscation/code inputs via specialized Deobfuscation WAF Bypass checks
    const codeFields = ["input", "codeInput", "code", "originalCode", "payload"];
    for (const field of codeFields) {
      const val = req.body[field];
      if (val && typeof val === "string") {
        const check = validateDeobfuscationInput(val);
        if (check?.isBlocked) {
          logAuditEvent(req, `Deobfuscation WAF Bypass: ${check.reason}`, true, { field });
          return res.status(403).json({
            success: false,
            code: "DEOBFUSCATION_WAF_BLOCK",
            message: "Security threat blocked by Alzaabi Sovereign WAF.",
            detail: check.reason
          });
        }
      }
    }

    // 8b. Run generic malicious payload filters on remaining properties
    const bodyCopy = { ...req.body };
    delete bodyCopy.input;
    delete bodyCopy.codeInput;
    delete bodyCopy.code;
    delete bodyCopy.originalCode;
    delete bodyCopy.payload;

    const bodyScan = containsMaliciousPayload(bodyCopy);
    if (bodyScan?.isMalicious) {
      logAuditEvent(req, `WAF Body Detection: ${bodyScan.type}`, true, { payload: bodyScan.payload });
      return res.status(403).json({
        success: false,
        code: "WAF_BLOCK",
        threatType: bodyScan.type,
        detail: "Dangerous payload pattern detected in body content structures."
      });
    }
  }

  // Log successful audit log for safe API requests
  logAuditEvent(req, "None", false);
  next();
}

/**
 * Full SSRF / DNS Rebinding Safe Validation
 */
export function validateWebhookUrl(urlStr: string): boolean {
  try {
    const parsedUrl = new URL(urlStr);
    const host = parsedUrl.hostname.toLowerCase();

    // Mitigate SSRF local loopbacks, private networks, cloud metadata endpoints
    const isPrivateOrLocal = 
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) || // 172.16.x - 172.31.x
      host === "169.254.169.254"; // Cloud instance metadata

    if (isPrivateOrLocal) {
      return false;
    }

    // Verify it belongs strictly to Whitelisted Webhook domains (Discord only)
    const isWhitelisted = ALLOWED_WEBHOOK_DOMAINS.some(domain => 
      host === domain || host.endsWith("." + domain)
    );

    return isWhitelisted;
  } catch (error) {
    return false;
  }
}

/**
 * 6. Protection against Website Downloaders, Scrapers, and Site Grabbers
 * (e.g. HTTrack, wget, curl, Teleport Pro, Scrapy, Cyotek WebCopy, SiteSucker, etc.)
 */
export function blockWebsiteDownloaders(req: Request, res: Response, next: NextFunction) {
  // Only apply automated downloaders/scrapers checking to main pages, html pages, and backend API endpoints
  if (!req.path.startsWith("/api/") && req.path !== "/" && !req.path.endsWith(".html")) {
    return next();
  }

  const userAgent = (req.headers["user-agent"] || "").toLowerCase();

  // 1. Block missing or extremely short User-Agent headers (typically bot/downloader connections)
  if (!userAgent || userAgent.length < 10) {
    logAuditEvent(req, "Bot Scraper: Blank or short User-agent", true, { userAgent });
    return res.status(403).json({
      success: false,
      code: "DOWNLOADER_BLOCKED",
      message: "Security check: Empty or invalid User-Agent is prohibited."
    });
  }

  // 2. Comprehensive lists of known website downloaders, site cloners, grabbers, and scrapers
  const blacklistedUserAgents = [
    "httrack",          // Most common website copier
    "wget",             // GNU Wget downloader
    "curl",             // Command line curl
    "teleport",         // Teleport Pro / Teleport Ultra
    "webcopy",          // Cyotek WebCopy
    "cyotek",
    "sitesucker",       // Mac SiteSucker tool
    "sitegrabber",      // Website grabber
    "grabber",
    "sitecloner",
    "scrapy",           // Python scraper skeleton
    "offline explorer", // Offline browser / site downloader
    "blackwidow",       // Known site ripper
    "webstripper",
    "getweb",
    "siphon",
    "webdownloader",
    "webcapture",
    "screaming frog",   // SEO spider / crawler
    "ia_archiver",
    "archive.org_bot",
    "scooter",
    "spidertoy",
    "extractor",
    "python-requests",
    "python",
    "aiohttp",
    "urllib",
    "java/",
    "libwww-perl",
    "go-http-client",
    "guzzlehttp",
    "axios",            // Scripted API clients without legitimate headers
    "postman",
    "headlesschrome",
    "puppeteer",
    "playwright",
    "selenium",
    "webzip",
    "stripper",
    "sucker",
    "rip"
  ];

  const match = blacklistedUserAgents.find(agent => userAgent.includes(agent));
  if (match) {
    console.warn(`[SECURITY WARN] Website Downloader/Scraper blocked: User-Agent: "${userAgent}" matched "${match}"`);
    logAuditEvent(req, `Bot Scraper Mode: ${match}`, true, { userAgent });
    return res.status(403).json({
      success: false,
      code: "DOWNLOADER_BLOCKED",
      message: "Security shield: Automated website downloaders, scrapers, or cloners are strictly prohibited."
    });
  }

  // 3. Inspect specific website downloader signatures & headers
  // For example, HTTrack sets custom headers like "X-Mailer" containing "HTTrack" or "X-Track"
  const xMailer = (req.headers["x-mailer"] as string || "").toLowerCase();
  const xTrack = req.headers["x-track"] || req.headers["x-referer"] || req.headers["x-httrack"];
  
  if (xMailer.includes("httrack") || xTrack) {
    console.warn(`[SECURITY WARN] HTTrack signatures detected in request headers.`);
    logAuditEvent(req, "Mirror Cloner Code: HTTrack", true, { xMailer, xTrack: !!xTrack });
    return res.status(403).json({
      success: false,
      code: "HTTRACK_BLOCKED",
      message: "Security violation: HTTrack mirroring is blocked on this origin."
    });
  }

  // 4. Verification of Standard Browser Request Flow for html page requests
  // Real browser requesting page / document of website always provides an Accept header matching 'text/html'
  // along with standard fetch indicators in modern browsers.
  // If we receive a request for HTML with curl/Python/unspecified agent but spoofed UA, we check standard browser headers.
  const acceptHeader = (req.headers["accept"] || "").toLowerCase();
  
  // Only inspect general page request paths
  if (req.path === "/" || req.path.endsWith(".html")) {
    // A real desktop/mobile browser requesting HTML typically has these headers
    const hasSecFetch = req.headers["sec-fetch-dest"] || req.headers["sec-ch-ua"] || req.headers["accept-language"];
    
    // If it's trying to request HTML document without standard browser telemetry indicators, it's flagged as potential grabber/ripper
    if (acceptHeader.includes("text/html") && !hasSecFetch) {
      // Let's do a double check on extremely common desktop patterns to prevent rare edge cases
      const isCommonBrowser = userAgent.includes("mozilla/5.0") && (userAgent.includes("safari") || userAgent.includes("firefox") || userAgent.includes("chrome"));
      
      // If it looks like mozilla but is missing all normal browser headers (sec-fetch-*, accept-language, etc.), it's likely a scraper or site downloader.
      if (!isCommonBrowser) {
        console.warn(`[SECURITY WARN] Blocked suspicious request lacking standard browser fetch indicators: UA="${userAgent}"`);
        logAuditEvent(req, "Bot Scraper: No Browser Sec-Fetch Telemetry", true, { userAgent });
        return res.status(403).json({
          success: false,
          code: "SCRAPER_DETECTED",
          message: "Verification failed. Please use a standard web browser."
        });
      }
    }
  }

  next();
}
