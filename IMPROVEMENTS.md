# Crossbar Improvements

This document tracks improvements made to Crossbar and planned future enhancements. Use it as a reference when creating feature branches.

---

## Completed Improvements

### 1. Context Window `0` Bug Fix

**Problem**: The model selection UI displayed `0 ctx` for models, and `model-info.ts` showed `n/a` for context size.

**Root Cause**: llama.cpp's `/props` endpoint returns `n_ctx: 0` (or omits it entirely). The adapter used `propsNCtx ?? entry.meta?.n_ctx_train`, which evaluated to `0` since `0 !== undefined` is `true`. JavaScript's nullish coalescing (`??`) only falls back on `null`/`undefined`, not `0`.

**Fix**: Updated `src/adapters/llamacpp.ts` to treat `contextWindow: 0` as "not reported":

```typescript
// Before (broken):
const ctx = propsNCtx ?? entry.meta?.n_ctx_train;
if (ctx !== undefined) {
  descriptor.contextWindow = ctx;
}

// After (fixed):
const ctx = propsNCtx ?? entry.meta?.n_ctx_train;
if (ctx !== undefined && ctx > 0) {
  descriptor.contextWindow = ctx;
}
```

**Impact**:
- Models without context info no longer show `0 ctx` in the UI
- `model-info.ts` correctly shows "n/a" for unknown context size
- Pi uses its own safe defaults (128k contextWindow, unbounded maxTokens) when context is not reported
- Applied the same `> 0` guard in `src/ui/onboarding.ts` for robustness against stale cached data

**Files Modified**:
- `src/adapters/llamacpp.ts` — `listModels()` and `toPiModel()` now check `ctx > 0`
- `src/ui/onboarding.ts` — `buildModelItems()` now checks `m.contextWindow > 0`
- `tests/adapters/llamacpp-maxtokens-fix.test.ts` — Updated regression tests

---

### 2. MaxTokens / n-predict Extraction

**Problem**: `model-info.ts` showed `➡️ n/a` for maxTokens even though the server reports `--n-predict` in the model args.

**Root Cause**: The adapter only extracted `--ctx-size` for `contextWindow`, but never extracted `--n-predict` for `maxTokens`. The `/props` `n_predict` field was also ignored.

**Fix**: Updated `src/adapters/llamacpp.ts` to extract `--n-predict` from `status.args` and `n_predict` from `/props`:

```typescript
// Extract n-predict for maxTokens.
// Priority: --n-predict from status.args > /props n_predict
const argPredict = extractArg(entry.status?.args, "--n-predict");
const maxTokens =
  (argPredict ? Number(argPredict) : undefined) ??
  propsNPredict;
if (maxTokens !== undefined && maxTokens > 0) {
  descriptor.maxTokens = maxTokens;
}
```

**Impact**:
- `model-info.ts` now shows the actual maxTokens (e.g., `➡️ 32k` instead of `➡️ n/a`)
- Models loaded with explicit `--n-predict` get correct maxTokens in the UI
- Fallback to `/props` n_predict when --n-predict is not in args
- Applied the same `> 0` guard as contextWindow

**Files Modified**:
- `src/adapters/llamacpp.ts` — Added n-predict extraction in `listModels()`, added `n_predict` to `PropsBody` interface
- `tests/adapters/llamacpp-maxtokens-fix.test.ts` — Updated tests to expect correct maxTokens values

---

## Planned Improvements

### 3. Model List Column Enhancements

**Goal**: Add more columns to the model selection list to show model description.

**Current State**:
- Model selection shows: `● ModelName` (label) and context window + capabilities (description)
- n-predict/maxTokens is now extracted and shown in `model-info.ts` ✅

**Planned Implementation**:

```
┌──────────────────────────┬──────────┬─────────────────────┐
│ Model Name               │ Context  │ Description         │
├──────────────────────────┼──────────┼─────────────────────┤
│ ● NVIDIA-Nemotron-3...   │ 32k ctx  │ loaded · 4B params  │
│ Qwen-AgentWorld-...      │ 8k ctx   │                     │
│ Qwen3.6-35B-A3B-...      │ 8k ctx   │                     │
│ Qwen36_35A3_optimum      │ 128k ctx │ loaded              │
└──────────────────────────┴──────────┴─────────────────────┘
```

**Implementation Steps**:
1. Update `SelectList` rendering to show multiple columns
2. Add model description column (params, architecture, quantization)

**Files to Modify**:
- `src/core/types.ts` — Update `ModelDescriptor` interface if needed
- `src/ui/onboarding.ts` — Update `buildModelItems()` to include description
- `src/ui/loaded-widget.ts` — Consider showing n-predict in status bar

### 3. Model Name Truncation with Ellipsis

**Goal**: Display long model names as "beginning...end" instead of truncating at the end.

**Current State**: Long model names are truncated at the end (e.g., "Qwen-AgentWorld-35B-A3B-...")

**Planned Implementation**:
```typescript
function truncateMiddle(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  const charsPerSide = Math.floor((maxWidth - 3) / 2);
  return text.slice(0, charsPerSide) + "…" + text.slice(-charsPerSide);
}
```

**Example**:
- `"Qwen-AgentWorld-35B-A3B-UD-IQ4_NL"` → `"Qwen-AgentWo…-UD-IQ4_NL"`

**Files to Modify**:
- `src/ui/onboarding.ts` — Add `truncateMiddle()` and apply to model names in `buildModelItems()`
- `src/ui/loaded-widget.ts` — Consider applying to status bar display

### 4. Window Border Enhancements

**Goal**: Make model selection overlays "real" windows with borders on all sides.

**Current State**: Overlays have top/bottom borders via `DynamicBorder` components, but side borders may be missing.

**Planned Implementation**:
- Wrap `SelectList` in a proper `Container` with side borders
- Use `Border` component from `pi-tui` for full border rendering
- Ensure consistent styling across all overlays

**Files to Modify**:
- `src/ui/onboarding.ts` — Update `selectOverlay()` and `selectServerOverlay()`
- `src/ui/loaded-widget.ts` — Consider adding borders to status widget

### 5. Default Context Size for Unloaded Models

**Goal**: Show context size for unloaded models that don't report it via `--ctx-size`.

**Current State**: Models loaded without explicit `--ctx-size` show "n/a" for context size.

**Options**:
1. **Accept "n/a"** — Leave models without context info as "n/a" (current behavior)
2. **Use server default** — Read default context size from `/props` (currently `0`)
3. **Configurable default** — Add a configurable default context size (e.g., 128k for Qwen3.x)
4. **Server-side fix** — Configure llama.cpp server to always include `--ctx-size` in args

**Recommendation**: Option 3 (configurable default) gives users control without hiding information.

**Files to Modify**:
- `src/adapters/llamacpp.ts` — Add configurable default context size
- `src/core/types.ts` — Add `defaultContextSize` to adapter config
- `src/ui/onboarding.ts` — Display default context size with a note

---

## Implementation Priority

| Priority | Improvement | Effort | Impact |
|----------|-------------|--------|--------|
| 🔴 High | Context window `0` bug fix | ✅ Done | Fixes broken UI |
| 🔴 High | MaxTokens / n-predict extraction | ✅ Done | Fixes broken UI |
| 🟡 Medium | Model list column enhancements | Medium | Better model info |
| 🟡 Medium | Model name truncation with ellipsis | Low | Better UX |
| 🟢 Low | Window border enhancements | Low | Visual polish |
| 🟢 Low | Default context size for unloaded models | Low | More complete info |

---

## Branch Strategy

When implementing these improvements:

1. **Create a new branch**: `git checkout -b improvements/context-window-fix`
2. **Start with the highest priority** item that isn't done
3. **Test each change** before moving to the next
4. **Commit frequently** with clear messages
5. **Reference this document** in commit messages

Example branch names:
- `feat/model-list-columns` — For improvement #3
- `fix/model-name-truncation` — For improvement #4
- `enhance/window-borders` — For improvement #5
- `feat/default-context-size` — For improvement #6

---

## Notes

- All changes should preserve backward compatibility
- Tests should be updated or added for new functionality
- Documentation should be updated when user-facing behavior changes
- The `extractArg()` helper in `llamacpp.ts` can be reused for parsing CLI-style arguments (`--flag value`)
