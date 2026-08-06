import Anthropic from '@anthropic-ai/sdk';

/** Server-only Claude client — do not import from client components. */
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
