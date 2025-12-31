// Thin edge entrypoint: keep this file small to reduce brittleness.
// All logic lives in handler.ts (same folder).
import { handler } from "./handler.ts";

Deno.serve(handler);
