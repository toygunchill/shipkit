#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { ConfigError, loadConfig } from "./config/load.js";
import { validate } from "./validate/rules.js";

const program = new Command();
program.name("shipkit").version("0.1.0").exitOverride();

program
  .command("check")
  .description("Validate a pull-request title and body against .shipkit.yml")
  .requiredOption("--title <title>", "pull-request title")
  .requiredOption("--body-file <path>", "file holding the pull-request body")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .action((options: { title: string; bodyFile: string; config: string }) => {
    let body: string;
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch {
      console.error(`Cannot read body file at ${options.bodyFile}`);
      process.exit(2);
    }

    try {
      const config = loadConfig(options.config);
      const result = validate({ title: options.title, body, config });
      if (result.ok) {
        console.log("ok");
        process.exit(0);
      }
      for (const finding of result.findings) {
        console.error(`${finding.rule}: ${finding.message}`);
      }
      process.exit(1);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        process.exit(2);
      }
      throw error;
    }
  });

try {
  program.parse();
} catch (error) {
  if (error instanceof CommanderError) {
    const isHelpOrVersion =
      error.code === "commander.helpDisplayed" || error.code === "commander.version";
    process.exit(isHelpOrVersion ? 0 : 2);
  }
  throw error;
}
