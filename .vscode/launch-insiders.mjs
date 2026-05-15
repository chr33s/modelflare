import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "chr33s.modelflare";
const PROPOSED_APIS = ["chatProvider", "languageModelThinkingPart"];
const currentFilePath = fileURLToPath(import.meta.url);
const vscodeDirectory = path.dirname(currentFilePath);
const workspaceRoot = path.dirname(vscodeDirectory);
const workspaceManifestPath = path.join(workspaceRoot, "package.json");
const insidersRoot = path.join(workspaceRoot, ".vscode-insiders");
const devExtensionPath = path.join(insidersRoot, "dev-extension");
const devManifestPath = path.join(devExtensionPath, "package.json");
const distPath = path.join(workspaceRoot, "dist");
const readmePath = path.join(workspaceRoot, "README.md");
const licensePath = path.join(workspaceRoot, "LICENSE.md");
const extensionsPath = path.join(insidersRoot, "extensions");
const dryRun = process.argv.includes("--dry-run");
const installVsix = process.argv.includes("--install-vsix");

function runtimeLabel(executablePath) {
  if (executablePath.toLowerCase().includes("insiders")) {
    return "VS Code Insiders";
  }

  return "VS Code";
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureLink(linkPath, targetPath, kind) {
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  const windowsTarget = kind === "dir" ? targetPath : relativeTarget;
  const symlinkTarget = process.platform === "win32" ? windowsTarget : relativeTarget;
  const symlinkKind = process.platform === "win32" && kind === "dir" ? "junction" : kind;

  try {
    const existing = await lstat(linkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === symlinkTarget) {
        return;
      }
    }

    await rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await symlink(symlinkTarget, linkPath, symlinkKind);
}

function isMissingFileError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EINVAL")
  );
}

async function readWorkspaceManifest() {
  return JSON.parse(await readFile(workspaceManifestPath, "utf8"));
}

function getPackagedVsixPath(manifest) {
  return path.join(workspaceRoot, `${manifest.name}-${manifest.version}.vsix`);
}

async function runCommand(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`VS Code command terminated with signal ${signal}.`));
        return;
      }

      reject(new Error(`VS Code command exited with code ${code ?? "unknown"}.`));
    });
  });
}

function candidateExecutables() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    ];
  }

  if (process.platform === "win32") {
    return [
      process.env.VSCODE_INSIDERS_PATH,
      process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            "Programs",
            "Microsoft VS Code Insiders",
            "Code - Insiders.exe",
          )
        : undefined,
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe")
        : undefined,
      process.env["ProgramFiles(x86)"]
        ? path.join(
            process.env["ProgramFiles(x86)"],
            "Microsoft VS Code Insiders",
            "Code - Insiders.exe",
          )
        : undefined,
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
        : undefined,
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")
        : undefined,
      process.env["ProgramFiles(x86)"]
        ? path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe")
        : undefined,
    ].filter((candidate) => typeof candidate === "string");
  }

  return [process.env.VSCODE_INSIDERS_PATH, "/usr/bin/code-insiders", "/usr/bin/code"].filter(
    (candidate) => typeof candidate === "string",
  );
}

async function findExecutableInPath(commandNames) {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    for (const commandName of commandNames) {
      const candidate = path.join(directory, commandName);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function resolveInsidersExecutable() {
  const pathCandidate = await findExecutableInPath(
    process.platform === "win32"
      ? [
          "code-insiders.cmd",
          "code-insiders.exe",
          "code-insiders.bat",
          "code.cmd",
          "code.exe",
          "code.bat",
        ]
      : ["code-insiders", "code"],
  );
  const candidates = [
    process.env.VSCODE_INSIDERS_PATH,
    pathCandidate,
    ...candidateExecutables(),
  ].filter((candidate, index, allCandidates) => {
    return typeof candidate === "string" && allCandidates.indexOf(candidate) === index;
  });

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find a VS Code desktop runtime. Install VS Code Insiders, add code-insiders to PATH, or set VSCODE_INSIDERS_PATH.",
  );
}

async function writeDevManifest() {
  const manifest = await readWorkspaceManifest();
  manifest.enabledApiProposals = PROPOSED_APIS;

  await mkdir(devExtensionPath, { recursive: true });
  await writeFile(devManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await ensureLink(path.join(devExtensionPath, "dist"), distPath, "dir");

  if (await pathExists(readmePath)) {
    await ensureLink(path.join(devExtensionPath, "README.md"), readmePath, "file");
  }

  if (await pathExists(licensePath)) {
    await ensureLink(path.join(devExtensionPath, "LICENSE.md"), licensePath, "file");
  }
}

async function installPackagedExtension(executable, label, vsixPath) {
  if (!(await pathExists(vsixPath))) {
    throw new Error(
      `Missing ${path.basename(vsixPath)}. Run npm run package before launching Insiders with --install-vsix.`,
    );
  }

  await runCommand(executable, [
    "--user-data-dir",
    insidersRoot,
    "--extensions-dir",
    extensionsPath,
    "--install-extension",
    vsixPath,
  ]);

  console.log(`Installed ${path.basename(vsixPath)} into the ${label} sandbox.`);
}

async function main() {
  if (!(await pathExists(distPath))) {
    throw new Error(
      "Missing dist/. Run npm run compile and npm run compile-web before launching Insiders.",
    );
  }

  await mkdir(insidersRoot, { recursive: true });
  await mkdir(extensionsPath, { recursive: true });
  await writeDevManifest();

  const executable = await resolveInsidersExecutable();
  const label = runtimeLabel(executable);
  const manifest = installVsix ? await readWorkspaceManifest() : undefined;
  const packagedVsixPath = manifest ? getPackagedVsixPath(manifest) : undefined;
  const args = [
    "--new-window",
    "--user-data-dir",
    insidersRoot,
    "--extensions-dir",
    extensionsPath,
    "--enable-proposed-api",
    EXTENSION_ID,
    "--extensionDevelopmentPath",
    devExtensionPath,
    workspaceRoot,
  ];

  if (dryRun) {
    console.log(`Runtime: ${label}`);
    console.log(`Executable: ${executable}`);
    console.log(`User data dir: ${insidersRoot}`);
    if (packagedVsixPath) {
      console.log(`Install VSIX: ${packagedVsixPath}`);
    }
    console.log(`Dev extension path: ${devExtensionPath}`);
    console.log(`Args: ${args.join(" ")}`);
    return;
  }

  if (packagedVsixPath) {
    await installPackagedExtension(executable, label, packagedVsixPath);
  }

  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(`Launched ${label} with ${PROPOSED_APIS.join(", ")} enabled for ${EXTENSION_ID}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
