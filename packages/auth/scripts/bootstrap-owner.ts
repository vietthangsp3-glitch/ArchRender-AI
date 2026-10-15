import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { createDatabaseClient } from "@archrender/database";
import { config as loadEnvironment } from "dotenv";

import { bootstrapOwner } from "../src/bootstrap-owner.js";
import { validatePasswordPolicy } from "../src/password.js";

loadEnvironment({ path: new URL("../../database/.env", import.meta.url), quiet: true });

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
    throw new Error("Bootstrap must run in an interactive terminal.");
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Bootstrap cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          stdout.write("*");
        }
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const reader = createInterface({ input: stdin, output: stdout });
  const database = createDatabaseClient();
  try {
    const email = await reader.question("Owner email: ");
    const displayNameInput = await reader.question("Display name (optional): ");
    reader.close();
    const password = await readHidden("Password: ");
    const confirmation = await readHidden("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const errors = validatePasswordPolicy(password);
    if (errors.length > 0) throw new Error(errors[0]);

    const result = await bootstrapOwner(database, {
      email,
      password,
      ...(displayNameInput.trim() ? { displayName: displayNameInput.trim() } : {}),
    });
    if (result.status === "already_bootstrapped") {
      stdout.write("Owner bootstrap has already been completed. No changes were made.\n");
      process.exitCode = 2;
      return;
    }
    stdout.write("Owner created successfully. Password was not logged.\n");
  } finally {
    reader.close();
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Bootstrap failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
