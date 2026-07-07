/**
 * Backwards-compat re-export shim.
 *
 * The instructions template moved to `instructions-template.ts` so it
 * can be shared across all agent targets (Claude Code, Cursor, Codex
 * CLI, opencode). This file is preserved purely so existing imports
 * (`solidkg` consumers, downstream tooling) keep
 * working unchanged. New code should import from
 * `./instructions-template` directly.
 *
 * @deprecated Import from `./instructions-template` instead.
 */

export {
  SOLIDKG_SECTION_START,
  SOLIDKG_SECTION_END,
  CLAUDE_MD_TEMPLATE,
  INSTRUCTIONS_TEMPLATE,
} from './instructions-template';
