#!/usr/bin/env node
// Five-line wrapper (R6, 15-spec.md D1): argv + production ports, nothing
// else. Nothing else in the codebase constructs a port.
import { buildProductionApp } from "../src/io/production-app.ts";

process.exitCode = await buildProductionApp().run(process.argv.slice(2));
