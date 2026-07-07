export interface RedactionOptions {
  enabled?: boolean;
  redactEmails?: boolean;
  redactSecrets?: boolean;
}

const EMAIL_MASK = '[REDACTED_EMAIL]';
const SECRET_MASK = '[REDACTED_SECRET]';
const SECRET_KEY_PATTERN = String.raw`(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?token)`;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(\b${SECRET_KEY_PATTERN}\b\s*[:=]\s*)(["'\`])([^"'\`\r\n]{6,})(\2)`,
  'gi'
);
const ENV_SECRET_PATTERN = new RegExp(
  String.raw`(\b[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|AUTH[_-]?TOKEN)[A-Z0-9_]*\b\s*=\s*)([^\s#;]{6,})`,
  'g'
);
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
const PREFIXED_SECRET_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_\-]{12,}\b/g;

export function redactionEnabledFromEnv(): boolean {
  const raw = process.env.SOLIDKG_REDACT_CONTEXT ?? process.env.SOLIDKG_REDACTION;
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function resolveRedactionOptions(options: RedactionOptions | false | undefined): Required<RedactionOptions> {
  if (options === false) {
    return { enabled: false, redactEmails: false, redactSecrets: false };
  }
  return {
    enabled: options?.enabled ?? redactionEnabledFromEnv(),
    redactEmails: options?.redactEmails ?? true,
    redactSecrets: options?.redactSecrets ?? true,
  };
}

export function redactSensitiveText(text: string, options?: RedactionOptions | false): string {
  const resolved = resolveRedactionOptions(options);
  if (!resolved.enabled || text.length === 0) return text;

  let redacted = text;
  if (resolved.redactSecrets) {
    redacted = redacted
      .replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${SECRET_MASK}${quote}`)
      .replace(ENV_SECRET_PATTERN, (_match, prefix: string) => `${prefix}${SECRET_MASK}`)
      .replace(BEARER_PATTERN, `Bearer ${SECRET_MASK}`)
      .replace(PREFIXED_SECRET_PATTERN, SECRET_MASK);
  }
  if (resolved.redactEmails) {
    redacted = redacted.replace(EMAIL_PATTERN, EMAIL_MASK);
  }
  return redacted;
}
