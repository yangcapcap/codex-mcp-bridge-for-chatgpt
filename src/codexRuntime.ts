import { CLI_INSTALL_VALIDATION_ID, verifyCliConnection } from "./runtimeCompatibility.js";
import { inspectCliProtocol, type CliProtocolSupport } from "./cliProtocol.js";
import { accessSync, constants, readFileSync, realpathSync, statSync, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { access, chmod, open, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { installManagedCli } from "./runtimeDownloads.js";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./textIntegrity.js";

type RetainedCliLease = {file:string;directory:string;fileIdentity:string;publicationIdentity:string;directoryIdentity:string;directoryPublicationIdentity:string;sha256:string;failed:boolean};
const retainedCliLeases=new WeakMap<()=>Promise<void>,RetainedCliLease>();
const leaseStatIdentity=(value:import('node:fs').BigIntStats,file:boolean)=>[
  value.dev,value.ino,value.mode,value.uid,value.gid,value.nlink,
  ...(file?[value.size,value.mtimeNs,value.ctimeNs]:[])
].join(':');
// Rename may change ctime; the original inode, private metadata and write history must survive publication.
const leaseCreationIdentity=(value:import('node:fs').BigIntStats)=>[value.dev,value.ino,value.mode,value.uid,value.gid,value.nlink].join(':');
const leasePublicationIdentity=(value:import('node:fs').BigIntStats)=>[value.dev,value.ino,value.mode,value.uid,value.gid,value.nlink,value.size,value.mtimeNs].join(':');
const leaseDirectoryPublicationIdentity=(value:import('node:fs').BigIntStats)=>[value.dev,value.ino,value.mode,value.uid,value.gid].join(':');
function readRetainedCliLease(file:string,directory:string):Omit<RetainedCliLease,'failed'>|undefined {
  let descriptor:number|undefined;
  try {
    if(path.dirname(file)!==directory || realpathSync(directory)!==directory)return;
    const uid=process.getuid?.();if(uid===undefined)return;
    const parent=lstatSync(directory,{bigint:true}),entry=lstatSync(file,{bigint:true});
    if(!parent.isDirectory() || parent.uid!==BigInt(uid) || (parent.mode&0o7777n)!==0o700n ||
      !entry.isFile() || entry.uid!==BigInt(uid) || (entry.mode&0o7777n)!==0o600n || entry.nlink!==1n || entry.size>32768n)return;
    descriptor=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const opened=fstatSync(descriptor,{bigint:true});if(leaseStatIdentity(opened,true)!==leaseStatIdentity(entry,true))return;
    const bytes=Buffer.alloc(Number(entry.size));let offset=0;
    while(offset<bytes.length){const count=readSync(descriptor,bytes,offset,bytes.length-offset,offset);if(!count)return;offset+=count;}
    const extra=Buffer.alloc(1);if(readSync(descriptor,extra,0,1,offset)!==0)return;
    if(leaseStatIdentity(fstatSync(descriptor,{bigint:true}),true)!==leaseStatIdentity(entry,true) ||
      leaseStatIdentity(lstatSync(file,{bigint:true}),true)!==leaseStatIdentity(entry,true) ||
      leaseStatIdentity(lstatSync(directory,{bigint:true}),false)!==leaseStatIdentity(parent,false) || realpathSync(directory)!==directory)return;
    const payload=parseJsonUtf8Strict(bytes,'CLI retained lease') as {pid?:unknown};
    if(!payload || payload.pid!==process.pid)return;
    return {file,directory,fileIdentity:leaseStatIdentity(entry,true),publicationIdentity:leasePublicationIdentity(entry),directoryIdentity:leaseStatIdentity(parent,false),directoryPublicationIdentity:leaseDirectoryPublicationIdentity(parent),sha256:createHash('sha256').update(bytes).digest('hex')};
  }catch{return;}finally{if(descriptor!==undefined){try{closeSync(descriptor);}catch{return;}}}
}
/** Only an original manager-created passive record can prove retained quiescence.
 * No release, lease removal, writer retirement or owner-exit claim occurs here. */
export function observeRetainedCliLease(release:unknown):boolean {
  if(typeof release!=='function')return false;
  const owned=retainedCliLeases.get(release as ()=>Promise<void>);if(!owned || owned.failed)return false;
  const current=readRetainedCliLease(owned.file,owned.directory);
  if(!current || current.fileIdentity!==owned.fileIdentity || current.directoryIdentity!==owned.directoryIdentity || current.sha256!==owned.sha256){owned.failed=true;return false;}
  return !owned.failed;
}

const executeFile = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const selectionSchema = z.object({
  id: z.string(), source: z.enum(["app", "terminal", "bridge"]), command: z.string(),
  physicalPath: z.string(), version: z.string().nullable()
});
const preferencesSchema = z.object({
  pinnedVersion: versionSchema.nullable().default(null),
  skippedVersion: versionSchema.nullable().default(null), notifications: z.boolean().default(true)
});
const managedSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/), version: versionSchema, command: z.string(),
  validation: z.string().optional(), verifiedAt: z.string(), bytes: z.number().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const operationSchema = z.object({
  action: z.string(), phase: z.enum(["downloading", "installing", "verifying", "pending", "failed", "complete"]),
  version: versionSchema.optional(), ownerPid: z.number().int(), error: z.string().nullable(),
  updatedAt: z.string(), downloadedBytes: z.number().optional(), totalBytes: z.number().optional()
});
const stateSchema = z.object({
  schemaVersion: z.literal(1), selection: selectionSchema.nullable(), selectionRequired: z.boolean(),
  selectionRevision: z.number().int().nonnegative().default(0), stagedSelectionRevision: z.number().int().nullable().default(null),
  pendingSelection: selectionSchema.nullable(), managed: z.array(managedSchema),
  activeId: z.string().nullable(), stagedId: z.string().nullable(), recoveryId: z.string().nullable(),
  preferences: preferencesSchema, latestVersion: versionSchema.nullable(), checkedAt: z.string().nullable(),
  lastSuccessfulCheckAt: z.string().nullable().default(null), updateCheckError: z.string().nullable().default(null),
  operation: operationSchema.nullable()
});
export type CliSelection = z.infer<typeof selectionSchema>;
type ManagedInstall = z.infer<typeof managedSchema>;
type RuntimeState = z.infer<typeof stateSchema>;
export type RuntimePreferences = z.infer<typeof preferencesSchema>;
export type CliCandidate = CliSelection & { available: boolean; compatible: boolean; protocol?: CliProtocolSupport; protocolError?: string };
export type CliRuntimeSnapshot = {
  selectionRevision?: number;
  knownVersions?: string[];
  selection: CliCandidate | null; candidates: CliCandidate[]; selectionRequired: boolean;
  configuredCommand?: string;
  environmentPending?: boolean;
  appliedEnvironment?: CliEnvironmentSummary;
  runningEnvironment?: CliEnvironmentSummary | null;
  requestedEnvironment?: CliEnvironmentSummary | null;
  requestedEnvironmentProblem?: { code: string; arguments: Record<string, string> } | null;
  pendingSelection: CliSelection | null; installedVersion: string | null; runningVersions: string[];
  updateVersion: string | null; latestVersion: string | null; checkedAt: string | null; lastSuccessfulCheckAt?: string | null; updateCheckError?: string | null;
  preferences: RuntimePreferences; operation: RuntimeState["operation"];
  stagedVersion: string | null; recoveryVersion: string | null; reclaimableBytes: number;
  actions: { install: boolean; update: boolean; remove: boolean; reinstall: boolean;
    rollback: boolean; cleanup: boolean; retry: boolean; applyPending: boolean; skip: boolean };
  billing?: import("./codexBilling.js").CodexBillingSnapshot;
  account?: import("./codexAccount.js").CodexAccountSnapshot | null;
  authSelection?: import("./codexAuthSelection.js").AuthSelectionSnapshot;
  managedVersions: { version: string; bytes: number; active: boolean; staged: boolean; recovery: boolean }[];
};
export type CliEnvironmentSummary = {
  runtimeHome: string;
  codexHome: string;
  configuredCommand: string | null;
  selection: CliCandidate | null;
};
export type RuntimeInstaller = (options: {
  directory: string; version: string; previousCommand?: string;
  onProgress: (phase: "downloading" | "installing" | "verifying", downloadedBytes?: number, totalBytes?: number) => Promise<void>;
}) => Promise<string>;
export type RuntimeManagerOptions = {
  root?: string; environment?: NodeJS.ProcessEnv; appPaths?: string[];
  probe?: (command: string) => Promise<string | null>; installer?: RuntimeInstaller;
  protocolProbe?: typeof inspectCliProtocol;
  latestVersion?: () => Promise<string>;
  defaultVersion?: string; discoverExternal?: boolean;
  explicitCommand?: string;
  validateInstall?: (command: string, version: string) => Promise<void>;
  validationId?: string;
};
type RuntimeLease = { pid: number; selection: CliSelection; startedAt: string };

export function defaultCodexAppPaths(home = homedir(), applicationsDirectory = "/Applications"): string[] {
  const userApplicationsDirectory = path.join(home, "Applications");
  return [applicationsDirectory, userApplicationsDirectory].flatMap(directory => [
    path.join(directory, "Codex.app/Contents/Resources/codex"),
    path.join(directory, "ChatGPT.app/Contents/Resources/codex"),
    path.join(directory, "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
  ]);
}

/** One saved choice. Discovery never changes an existing choice or an explicit removal. */
export class CodexRuntimeManager {
  private readonly changeListeners = new Set<() => void>();
  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  readonly root: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly options: RuntimeManagerOptions;
  private probeCache = new Map<string, { stamp: string; version: string | null; checkedAt: number }>();
  private digestCache = new Map<string, { stamp: string; digest: string }>();
  private protocolCache = new Map<string, { stamp: string; result: Promise<CliProtocolSupport> }>();

  constructor(options: RuntimeManagerOptions = {}) {
    this.options = options;
    this.environment = options.environment || process.env;
    const root = path.resolve(options.root || this.environment.CODEX_MCP_BRIDGE_RUNTIME_HOME ||
      path.join(homedir(), ".codex-mcp-bridge", "runtimes"));
    this.root = canonicalRuntimePath(root);
  }

  private get validationId(): string { return this.options.validationId || CLI_INSTALL_VALIDATION_ID; }

  private configuredCommand(): string | undefined {
    if (this.options.discoverExternal === false) return undefined;
    return this.options.explicitCommand || this.environment.CODEX_MCP_BRIDGE_CODEX || this.environment.CODEX_GPT_BRIDGE_CODEX || undefined;
  }

  /**
   * Synchronous, non-sensitive cache identity for the applied selection. The
   * same command and native-binary resolution used by admission is used here;
   * pending choices and installation progress are intentionally excluded.
   */
  appliedContextFingerprint(): string {
    const stateFile = path.join(this.root, "cli-state.json");
    let selection: CliSelection | null = null;
    let stateIssue: string | null = null;
    try {
      selection = stateSchema.parse(parseJsonUtf8Strict(readFileSync(stateFile), "runtime state")).selection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { stateIssue = createHash("sha256").update(readFileSync(stateFile)).digest("hex"); }
        catch (readError) { stateIssue = (readError as NodeJS.ErrnoException).code || "invalid"; }
      }
    }
    const configured = this.configuredCommand();
    const command = configured || selection?.command || null;
    let resolved = command;
    let physical: string | null = null;
    let commandStamp: string | null = null;
    let nativeStamp: string | null = null;
    if (command) {
      try {
        resolved = resolveOnPath(command, this.environment);
        physical = physicalCodexPath(resolved);
        commandStamp = fileStamp(resolved);
        nativeStamp = fileStamp(physical);
      } catch { /* A missing choice has its own identity and cannot borrow PATH. */ }
    }
    return createHash("sha256").update(JSON.stringify([
      this.root, configured ? "configured" : "saved", command, configured ? null : selection?.source,
      resolved, physical, commandStamp, nativeStamp, stateIssue
    ])).digest("hex");
  }

  private async managedPaths(state: RuntimeState): Promise<Map<string, ManagedInstall>> {
    const paths = new Map<string, ManagedInstall>();
    for (const install of state.managed) {
      const command = this.managedCommand(install);
      paths.set(command, install);
      try { paths.set(await realpath(command), install); } catch { /* Retain the known path for repair. */ }
    }
    return paths;
  }

  private async inspectConfigured(command: string, state: RuntimeState, candidates: CliCandidate[]): Promise<CliCandidate> {
    let resolved = command, physicalPath = command;
    try {
      resolved = await resolveOnPath(command, this.environment);
      physicalPath = await physicalCodexPath(resolved);
      if (process.platform === "win32" && physicalPath.endsWith(".exe")) resolved = physicalPath;
    } catch { /* Keep the explicit choice visible even when it is missing. */ }
    const candidate = candidates.find(item => item.physicalPath === physicalPath);
    const managed = (await this.managedPaths(state)).get(physicalPath);
    return this.inspectSelection({ id: selectionId(physicalPath), source: managed ? "bridge" : candidate?.source || "terminal",
      command: managed ? this.managedCommand(managed) : resolved, physicalPath, version: managed?.version ?? candidate?.version ?? null });
  }

  async discover(savedState?: RuntimeState): Promise<CliCandidate[]> {
    const state = savedState || await this.readState();
    const managedPaths = await this.managedPaths(state);
    const apps = this.options.discoverExternal === false ? [] : this.options.appPaths || defaultCodexAppPaths();
    const paths: { command: string; source: CliSelection["source"] }[] = [
      ...apps.map(command => ({ command, source: "app" as const })),
      ...(this.options.discoverExternal === false ? "" : this.environment.PATH || "").split(path.delimiter).filter(Boolean)
        .flatMap(directory => (process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"])
          .map(name => ({ command: path.resolve(directory, name), source: "terminal" as const }))),
      ...state.managed.filter(install => install.id === state.activeId).map(install => ({ command: this.managedCommand(install), source: "bridge" as const }))
    ];
    const found = await Promise.all(paths.map(async entry => {
      try {
        await access(entry.command, constants.X_OK);
        const physicalPath = await physicalCodexPath(entry.command);
        const managed = managedPaths.get(physicalPath);
        const command = managed ? this.managedCommand(managed)
          : process.platform === "win32" && physicalPath.endsWith(".exe") ? physicalPath : entry.command;
        const version = await this.probe(command);
        return this.inspectSelection({ source: managed ? "bridge" as const : entry.source,
          command, id: selectionId(physicalPath), physicalPath, version }, state);
      } catch { return null; }
    }));
    // App provenance wins for a terminal symlink to the same app binary.
    const unique = new Map<string, CliCandidate>();
    for (const candidate of found) if (candidate && !unique.has(candidate.physicalPath)) unique.set(candidate.physicalPath, candidate);
    return [...unique.values()];
  }

  async snapshot(options: { selectInitial?: boolean } = {}): Promise<CliRuntimeSnapshot> {
    let state = await this.readState();
    const candidates = await this.discover(state);
    const configuredCommand = this.configuredCommand();
    if (options.selectInitial !== false && !configuredCommand && !state.selection && !state.selectionRequired) {
      const external = candidates.filter(candidate => candidate.source !== "bridge");
      const initial = external.length === 1 ? external[0] : external.length === 0
        ? candidates.find(candidate => state.managed.find(install => install.id === state.activeId && this.managedCommand(install) === candidate.command))
        : undefined;
      if (initial) {
        await this.changeState(current => {
          if (!current.selection && !current.selectionRequired) current.selection = selectionSchema.parse(initial);
        });
        state = await this.readState();
      }
    }
    const selection = configuredCommand ? await this.inspectConfigured(configuredCommand, state, candidates)
      : state.selection ? await this.inspectSelection(state.selection) : null;
    const leases = await this.liveLeases();
    const protectedIds = this.protectedIds(state, leases, selection);
    const abandoned = await this.abandonedInstalls(state);
    const reclaimableBytes = state.managed.filter(item => !protectedIds.has(item.id)).reduce((sum, item) => sum + item.bytes, 0) +
      abandoned.reduce((sum, item) => sum + item.bytes, 0);
    const isManaged = selection?.source === "bridge";
    const updateVersion = !configuredCommand && isManaged && !state.preferences.pinnedVersion && state.latestVersion &&
      newerThan(state.latestVersion, selection.version) &&
      state.preferences.skippedVersion !== state.latestVersion ? state.latestVersion : null;
    const busy = state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase) && pidAlive(state.operation.ownerPid);
    const stagedVersion = state.managed.find(item => item.id === state.stagedId)?.version ?? null;
    const updateAlreadyStaged = !!updateVersion && stagedVersion === updateVersion;
    const recovery = state.managed.find(item => item.id === state.recoveryId);
    const recoveryCommand = recovery ? this.managedCommand(recovery) : null;
    const recoveryAvailable = recovery && recoveryCommand ? (await this.inspectSelection({
      id: selectionId(recoveryCommand), source: "bridge", command: recoveryCommand,
      physicalPath: recoveryCommand, version: recovery.version
    }, state)).available : false;
    return {
      selectionRevision: state.selectionRevision,
      knownVersions: [...new Set([...state.managed.map(item => item.version), ...(state.latestVersion ? [state.latestVersion] : [])])],
      selection, candidates, selectionRequired: !selection || !selection.available || !selection.compatible,
      ...(configuredCommand ? { configuredCommand } : {}),
      pendingSelection: state.pendingSelection, installedVersion: selection?.version ?? null,
      runningVersions: [...new Set(leases.map(item => item.selection.version).filter((value): value is string => value !== null))],
      updateVersion, latestVersion: state.latestVersion, checkedAt: state.checkedAt,
      lastSuccessfulCheckAt: state.lastSuccessfulCheckAt, updateCheckError: state.updateCheckError, preferences: state.preferences,
      operation: state.operation, stagedVersion,
      recoveryVersion: recovery?.version ?? null, reclaimableBytes,
      managedVersions: state.managed.map(item => ({ version: item.version, bytes: item.bytes, active: item.id === state.activeId,
        staged: item.id === state.stagedId, recovery: item.id === state.recoveryId })),
      actions: {
        install: !configuredCommand && !busy && !state.managed.some(item => item.id === state.activeId),
        update: !busy && !!updateVersion && !updateAlreadyStaged, remove: !busy && !(configuredCommand && isManaged) && state.managed.length > 0 && !leases.some(item => item.selection.source === "bridge"),
        reinstall: !configuredCommand && !busy && !!isManaged && !selection.available,
        rollback: !configuredCommand && !busy && !!isManaged && !!recovery && recoveryAvailable && (!state.preferences.pinnedVersion || state.preferences.pinnedVersion === recovery.version),
        cleanup: !busy && reclaimableBytes > 0, retry: !configuredCommand && state.operation?.phase === "failed",
        applyPending: !configuredCommand && !busy && leases.length === 0 && !!(state.pendingSelection || state.stagedId), skip: !busy && !!updateVersion && !updateAlreadyStaged
      }
    };
  }

  /** Stable across activation, but changes when the user selects another target. */
  async activationTarget(): Promise<{ revision: number; command: string | null; description: string }> {
    const state = await this.readState();
    return this.activationTargetFromState(state);
  }

  private activationTargetFromState(state: z.infer<typeof stateSchema>): { revision: number; command: string | null; description: string } {
    const staged = state.managed.find(item => item.id === state.stagedId);
    const selectsStaged = staged && (state.stagedSelectionRevision === null || state.stagedSelectionRevision === state.selectionRevision)
      && (!state.preferences.pinnedVersion || state.preferences.pinnedVersion === staged.version);
    const selection = state.pendingSelection || state.selection;
    const command = this.configuredCommand() || state.pendingSelection?.command || (selectsStaged ? this.managedCommand(staged) : state.selection?.command) || null;
    return { revision: state.selectionRevision, command,
      description: [selection?.source || (staged ? "bridge" : "Codex"), selectsStaged ? staged.version : selection?.version].filter(Boolean).join(" · ") };
  }

  async select(id: string): Promise<CliRuntimeSnapshot> {
    if (this.configuredCommand()) throw new Error("CODEX_EXPLICIT_OVERRIDE: Remove the explicit Codex path from the runtime environment before changing the saved selection.");
    const candidate = (await this.discover()).find(item => item.id === id);
    if (!candidate || !candidate.available) throw new Error("CODEX_SELECTION_UNAVAILABLE: Refresh the available installations.");
    assertCompatibleSelection(candidate);
    const selection = selectionSchema.parse(candidate);
    await this.changeState(async state => {
      state.selectionRevision++;
      if ((await this.liveLeases()).length) {
        state.pendingSelection = selection;
        if (!state.operation || !["downloading", "installing", "verifying"].includes(state.operation.phase)) state.operation = operation("select", "pending");
      } else {
        state.selection = selection; state.pendingSelection = null; state.selectionRequired = false;
        if (!state.operation || !["downloading", "installing", "verifying"].includes(state.operation.phase)) state.operation = null;
      }
    });
    return this.snapshot();
  }

  /** Called by execution entrypoints, authentication and catalogs, never with a PATH fallback. */
  async resolve(explicitCommand: string | undefined = this.configuredCommand()): Promise<CliSelection> {
    if (explicitCommand) {
      const state = await this.readState();
      const selection = await this.inspectConfigured(explicitCommand, state, await this.discover(state));
      if (!selection.available) throw new Error("CODEX_SELECTION_UNAVAILABLE: The configured Codex executable is missing or damaged.");
      assertCompatibleSelection(selection);
      return selectionSchema.parse(selection);
    }
    await this.applyPending();
    const snapshot = await this.snapshot();
    if (!snapshot.selection) throw new Error("CODEX_SELECTION_REQUIRED: Choose or install Codex in the bridge settings.");
    if (!snapshot.selection.available) throw new Error("CODEX_SELECTION_UNAVAILABLE: Restore the selected installation or explicitly choose another one.");
    assertCompatibleSelection(snapshot.selection);
    return selectionSchema.parse(snapshot.selection);
  }

  async lease(selection: CliSelection): Promise<() => Promise<void>> {
    const directory = path.join(this.root, "leases");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
    // Readers do not take the activation lock. Publish only complete records,
    // keeping the in-progress write outside the directory they enumerate.
    const temporary = path.join(this.root, `.lease-${path.basename(file)}.tmp`);
    const payload=JSON.stringify({pid:process.pid,selection,startedAt:new Date().toISOString()});
    const payloadSHA256=createHash('sha256').update(payload).digest('hex');
    const originalDirectoryIdentity=leaseDirectoryPublicationIdentity(lstatSync(directory,{bigint:true}));
    let originalPublicationIdentity:string|undefined;
    const handle=await open(temporary,'wx',0o600);
    let failed=false,failure:unknown;
    try {
      // Retain the creation descriptor; a replaced pathname never becomes its owner.
      const descriptor=handle.fd,created=fstatSync(descriptor,{bigint:true});
      await handle.writeFile(payload);
      const written=fstatSync(descriptor,{bigint:true});
      if(leaseCreationIdentity(created)===leaseCreationIdentity(written) && written.isFile() &&
        written.nlink===1n && (written.mode&0o7777n)===0o600n && written.uid===BigInt(process.getuid!()))
        originalPublicationIdentity=leasePublicationIdentity(written);
      await rename(temporary,file);
    }catch(error){failed=true;failure=error;}
    try{await handle.close();}catch(error){
      if(failed)throw new AggregateError([failure,error],'CLI_LEASE_PUBLICATION_AND_CLOSE_FAILED',{cause:failure});
      throw error;
    }
    // Failed publication retains its private temporary evidence. A pathname at
    // this point may belong to a replacement, or creation may never have succeeded.
    if(failed)throw failure;
    const release=()=>{
      // This original capability can be called outside the router as well.
      const owned=retainedCliLeases.get(release);if(owned)owned.failed=true;
      return rm(file,{force:true});
    };
    const retained=readRetainedCliLease(file,directory);
    if(retained && retained.sha256===payloadSHA256 && retained.publicationIdentity===originalPublicationIdentity &&
      retained.directoryPublicationIdentity===originalDirectoryIdentity)retainedCliLeases.set(release,{...retained,failed:false});
    return release;
  }

  /** Seal the selection and its usage record under the same lock as activation/removal. */
  async acquire(explicitCommand: string | undefined = this.configuredCommand()): Promise<{ selection: CliSelection; fingerprint: string; protocol?: CliProtocolSupport; release: () => Promise<void> }> {
    const selection = await this.resolve(explicitCommand);
    return withRuntimeLock(this.root, "cli", async () => {
      const state = await this.readState();
      if (!explicitCommand && state.selection?.command !== selection.command) {
        throw new Error("CODEX_SELECTION_CHANGED: The user changed the selected installation. Retry with the saved choice.");
      }
      const inspected = await this.inspectSelection(selection);
      if (!inspected.available) throw new Error("CODEX_SELECTION_UNAVAILABLE: The selected installation needs recovery.");
      assertCompatibleSelection(inspected);
      const release = await this.lease(selection);
      try {
        return { selection, fingerprint: this.appliedContextFingerprint(), protocol: inspected.protocol, release };
      } catch (error) {
        await release();
        throw error;
      }
    });
  }

  async checkUpdates(): Promise<CliRuntimeSnapshot> {
    try {
      const latest = versionSchema.parse(await (this.options.latestVersion || latestStableCli)());
      await this.changeState(state => {
        state.latestVersion = latest; state.checkedAt = new Date().toISOString();
        state.lastSuccessfulCheckAt = state.checkedAt; state.updateCheckError = null;
        if (state.operation?.action === "check-updates") state.operation = null;
      });
    } catch {
      await this.changeState(state => {
        state.checkedAt = new Date().toISOString(); state.updateCheckError = "CODEX_UPDATE_CHECK_FAILED";
        if (!state.operation || ["complete", "failed"].includes(state.operation.phase)) {
          state.operation = { ...operation("check-updates", "failed"), error: "CODEX_UPDATE_CHECK_FAILED" };
        }
      });
      throw new Error("CODEX_UPDATE_CHECK_FAILED: Version information is unavailable. Your installed version is preserved.");
    }
    return this.snapshot();
  }

  async setPreferences(values: Partial<RuntimePreferences>): Promise<CliRuntimeSnapshot> {
    const parsed = preferencesSchema.partial().strict().parse(values);
    await this.changeState(state => {
      state.preferences = preferencesSchema.parse({ ...state.preferences, ...parsed });
      const staged = state.managed.find(item => item.id === state.stagedId);
      if (staged && state.preferences.pinnedVersion && staged.version !== state.preferences.pinnedVersion) {
        state.stagedId = null; state.stagedSelectionRevision = null;
        if (state.operation?.phase === "pending" && !state.pendingSelection) state.operation = { ...state.operation, phase: "complete" };
      }
    });
    return this.snapshot();
  }

  async install(action: "install" | "update" | "reinstall" = "install", requestedVersion?: string): Promise<CliRuntimeSnapshot> {
    const snapshot = await this.snapshot();
    if (!snapshot.actions[action]) throw new Error(`CODEX_ACTION_UNAVAILABLE: ${action} is not applicable.`);
    if (requestedVersion && action !== "install") throw new Error("CODEX_ACTION_UNAVAILABLE: An explicit version is only valid for a new installation.");
    let version: string;
    try {
      version = versionSchema.parse(action === "reinstall" ? snapshot.selection!.version
        : action === "update" ? snapshot.updateVersion : requestedVersion || snapshot.preferences.pinnedVersion || this.options.defaultVersion ||
          await (this.options.latestVersion || latestStableCli)());
    } catch {
      await this.changeState(state => {
        if (!state.operation || !["downloading", "installing", "verifying"].includes(state.operation.phase) || !pidAlive(state.operation.ownerPid)) {
          state.operation = { ...operation(action, "failed"), error: "CODEX_UPDATE_CHECK_FAILED" };
        }
      });
      throw new Error("CODEX_UPDATE_CHECK_FAILED: The latest stable version could not be resolved. Choose a known version explicitly or retry.");
    }
    if (snapshot.preferences.pinnedVersion && version !== snapshot.preferences.pinnedVersion) throw new Error("CODEX_VERSION_PINNED: Release the version pin before choosing another version.");
    const id = `${version}-${randomUUID()}`;
    const directory = path.join(this.root, "cli", id);
    const selectionRevision = snapshot.selectionRevision ?? 0;
    let registered = false;
    await this.changeState(state => {
      if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase) && pidAlive(state.operation.ownerPid)) {
        throw new Error("CODEX_OPERATION_BUSY: Another installation is in progress.");
      }
      if (action === "update" && (state.preferences.pinnedVersion || state.preferences.skippedVersion === version || state.selection?.command !== snapshot.selection?.command)) {
        throw new Error("CODEX_ACTION_UNAVAILABLE: Your update preferences or selection changed.");
      }
      if (action === "update" && state.managed.some(item => item.id === state.stagedId && item.version === version)) {
        throw new Error("CODEX_ACTION_UNAVAILABLE: This update is already waiting to be applied.");
      }
      if (action === "install" && state.activeId) throw new Error("CODEX_ACTION_UNAVAILABLE: An installation was already activated while resolving the version.");
      state.operation = operation(action, "downloading", version);
    });
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicRuntimeJson(path.join(directory, "bridge-install.json"), { schemaVersion: 1, id, version, owner: "codex-mcp-bridge" });
      const command = await (this.options.installer || installManagedCli)({
        directory, version, ...(action === "reinstall" ? { previousCommand: snapshot.selection?.command } : {}), onProgress: async (phase, downloadedBytes, totalBytes) => {
          await this.changeState(state => { state.operation = { ...operation(action, phase, version), downloadedBytes, totalBytes }; });
        }
      });
      if (!inside(directory, command) || await this.probe(command) !== version) throw new Error("CODEX_VERIFY_FAILED: Installed executable failed its version check.");
      if (this.options.validateInstall) await this.options.validateInstall(command, version);
      else if (!this.options.installer) await verifyCliConnection(command, this.environment);
      const install: ManagedInstall = { id, version, validation: this.validationId, command: path.relative(directory, command),
        verifiedAt: new Date().toISOString(), bytes: await directoryBytes(directory), sha256: await fileDigest(command) };
      await this.changeState(state => {
        state.managed.push(install);
        if (state.preferences.pinnedVersion && state.preferences.pinnedVersion !== version) {
          state.operation = operation(action, "complete", version);
        } else {
          state.stagedId = id; state.stagedSelectionRevision = selectionRevision;
          state.operation = operation(action, "pending", version);
        }
      });
      registered = true;
      await this.applyPending();
    } catch {
      if (!registered) await rm(directory, { recursive: true, force: true });
      const error = registered ? "CODEX_APPLY_FAILED" : "CODEX_INSTALL_FAILED";
      await this.changeState(state => { state.operation = { ...operation(registered ? "apply" : action, "failed", version), error }; });
      throw new Error(`${error}: Installation or activation failed. Your previous installation is preserved.`);
    }
    return this.snapshot();
  }

  async applyPending(expected?: { revision: number; command: string | null }): Promise<void> {
    if (this.configuredCommand()) {
      if (expected && expected.command !== this.configuredCommand()) throw new Error("LIFECYCLE_TARGET_CHANGED: The configured CLI changed.");
      return;
    }
    await this.changeState(async state => {
      const target = this.activationTargetFromState(state);
      if (expected && (target.revision !== expected.revision || target.command !== expected.command)) {
        throw new Error("LIFECYCLE_TARGET_CHANGED: The selected CLI changed before activation.");
      }
      if ((await this.liveLeases()).length) {
        if (expected && (state.stagedId || state.pendingSelection)) throw new Error("CODEX_APPLY_PENDING: A CLI lease still protects the previous selection.");
        return;
      }
      const applying = !!(state.stagedId || state.pendingSelection);
      if (state.stagedId) {
        const staged = state.managed.find(item => item.id === state.stagedId);
        if (state.preferences.pinnedVersion && staged?.version !== state.preferences.pinnedVersion) return;
        if (!staged || !await this.verified(staged)) {
          state.operation = { ...operation("apply", "failed"), error: "CODEX_VERIFY_FAILED" }; return;
        }
        state.recoveryId = state.activeId;
        state.activeId = staged.id; state.stagedId = null;
        const command = this.managedCommand(staged);
        if (state.stagedSelectionRevision === null || state.stagedSelectionRevision === state.selectionRevision) {
          const physicalPath = await physicalCodexPath(command);
          state.selection = { id: selectionId(physicalPath), source: "bridge", command, physicalPath, version: staged.version };
          state.selectionRequired = false;
        }
        state.stagedSelectionRevision = null;
      }
      if (state.pendingSelection) {
        state.selection = state.pendingSelection; state.pendingSelection = null; state.selectionRequired = false;
      }
      if (expected?.command && state.selection?.command !== expected.command) {
        throw new Error("CODEX_APPLY_FAILED: The reserved CLI could not be activated.");
      }
      if (state.operation && (state.operation.phase === "pending" || (applying && state.operation.action === "apply"))) {
        state.operation = { ...state.operation, phase: "complete", error: null, updatedAt: new Date().toISOString() };
      }
    });
  }

  async rollback(): Promise<CliRuntimeSnapshot> {
    if (!(await this.snapshot()).actions.rollback) throw new Error("CODEX_ACTION_UNAVAILABLE: No compatible recovery installation is available.");
    await this.changeState(async state => {
      if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase)) throw new Error("CODEX_OPERATION_BUSY: Installation is in progress.");
      const recovery = state.managed.find(item => item.id === state.recoveryId);
      if (!recovery || !await this.verified(recovery)) throw new Error("CODEX_VERIFY_FAILED: Recovery installation could not be verified.");
      if (state.preferences.pinnedVersion && state.preferences.pinnedVersion !== recovery.version) throw new Error("CODEX_VERSION_PINNED: Release the version pin before choosing another version.");
      state.stagedSelectionRevision = ++state.selectionRevision;
      state.stagedId = recovery.id; state.operation = operation("rollback", "pending", recovery.version);
    });
    await this.applyPending();
    return this.snapshot();
  }

  async remove(): Promise<CliRuntimeSnapshot> {
    await this.changeState(async state => {
      if (!state.managed.length) throw new Error("CODEX_NOT_BRIDGE_OWNED: App and terminal installations are managed by their owner.");
      const configured = this.configuredCommand();
      if (configured && (await this.inspectConfigured(configured, state, await this.discover(state))).source === "bridge") {
        throw new Error("CODEX_EXPLICIT_OVERRIDE: Remove the explicit Codex path from the runtime environment before deleting that installation.");
      }
      if ((await this.liveLeases()).some(item => item.selection.source === "bridge")) throw new Error("CODEX_IN_USE: Stop the bridge safely before removing its installation.");
      if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase)) throw new Error("CODEX_OPERATION_BUSY: Installation is in progress.");
      for (const install of state.managed) await rm(path.join(this.root, "cli", install.id), { recursive: true, force: true });
      for (const install of await this.abandonedInstalls(state)) await rm(path.join(this.root, "cli", install.id), { recursive: true, force: true });
      state.managed = []; state.activeId = null; state.stagedId = null; state.recoveryId = null;
      if (state.selection?.source === "bridge") { state.selection = null; state.selectionRequired = true; }
      if (state.pendingSelection?.source === "bridge") state.pendingSelection = null;
      state.selectionRevision++; state.stagedSelectionRevision = null; state.operation = null;
      // Deliberately retain preferences, auth profiles, Codex home and bridge settings.
    });
    return this.snapshot();
  }

  async cleanup(): Promise<CliRuntimeSnapshot> {
    await this.changeState(async state => {
      if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase)) throw new Error("CODEX_OPERATION_BUSY: Installation is in progress.");
      const configured = this.configuredCommand();
      const selected = configured ? await this.inspectConfigured(configured, state, await this.discover(state)) : undefined;
      const protectedIds = this.protectedIds(state, await this.liveLeases(), selected);
      for (const install of state.managed.filter(item => !protectedIds.has(item.id))) {
        await rm(path.join(this.root, "cli", install.id), { recursive: true, force: true });
      }
      state.managed = state.managed.filter(item => protectedIds.has(item.id));
      for (const install of await this.abandonedInstalls(state)) await rm(path.join(this.root, "cli", install.id), { recursive: true, force: true });
    });
    return this.snapshot();
  }

  async retry(): Promise<CliRuntimeSnapshot> {
    const state = await this.readState();
    if (state.operation?.phase !== "failed") throw new Error("CODEX_ACTION_UNAVAILABLE: There is no failed operation to retry.");
    const action = state.operation.action;
    if (action === "check-updates") return this.checkUpdates();
    if (action === "apply") { await this.applyPending(); return this.snapshot(); }
    if (action === "install" || action === "update" || action === "reinstall") return this.install(action);
    throw new Error("CODEX_ACTION_UNAVAILABLE: Repeat the requested action from settings.");
  }

  private managedCommand(install: ManagedInstall): string {
    const directory = path.join(this.root, "cli", install.id);
    const command = path.resolve(directory, install.command);
    if (!inside(directory, command)) throw new Error("CODEX_STATE_INVALID: Managed executable is outside its installation.");
    return command;
  }
  private async abandonedInstalls(state: RuntimeState): Promise<{ id: string; bytes: number }[]> {
    if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase)) return [];
    const entries = await readdir(path.join(this.root, "cli"), { withFileTypes: true }).catch(() => []);
    const result: { id: string; bytes: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(entry.name) || state.managed.some(item => item.id === entry.name)) continue;
      const directory = path.join(this.root, "cli", entry.name);
      try {
        const marker = parseJsonUtf8Strict<Record<string, unknown>>(
          await readFile(path.join(directory, "bridge-install.json")),
          "managed runtime installation marker"
        );
        if (marker.schemaVersion === 1 && marker.id === entry.name && marker.owner === "codex-mcp-bridge") result.push({ id: entry.name, bytes: await directoryBytes(directory) });
      } catch { /* Never reclaim unrecognized user files or incomplete ownership markers. */ }
    }
    return result;
  }
  private async verified(install: ManagedInstall): Promise<boolean> {
    try { return await fileDigest(this.managedCommand(install)) === install.sha256 && await this.probe(this.managedCommand(install)) === install.version; }
    catch { return false; }
  }
  private async inspectSelection(selection: CliSelection, savedState?: RuntimeState): Promise<CliCandidate> {
    const version = await this.probe(selection.command);
    let intact = true;
    let compatible = version !== null;
    if (selection.source === "bridge") {
      const installed = (savedState || await this.readState()).managed.find(item => this.managedCommand(item) === selection.command);
      compatible = !!installed && version !== null;
      try {
        const info = await stat(selection.command);
        const physicalPath = await physicalCodexPath(selection.command);
        // Older state may identify a managed installation by a symlinked root.
        // Match discovery without switching the saved command or installation.
        selection = { ...selection, physicalPath, id: selectionId(physicalPath) };
        const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        let cached = this.digestCache.get(selection.command);
        if (!cached || cached.stamp !== stamp) {
          cached = { stamp, digest: await fileDigest(selection.command) };
          this.digestCache.set(selection.command, cached);
        }
        intact = !!installed && installed.sha256 === cached.digest;
      } catch { intact = false; }
    }
    let protocol: CliProtocolSupport | undefined;
    let protocolError: string | undefined;
    if (compatible && intact) {
      const stamp = this.probeCache.get(selection.command)?.stamp || String(version);
      let check = this.protocolCache.get(selection.command);
      if (!check || check.stamp !== stamp) {
        check = { stamp, result: (this.options.protocolProbe || inspectCliProtocol)(selection.command, this.environment) };
        this.protocolCache.set(selection.command, check);
      }
      try { protocol = await check.result; compatible = protocol.compatible; }
      catch { compatible = false; protocolError = "CODEX_PROTOCOL_UNVERIFIED"; this.protocolCache.delete(selection.command); }
    } else compatible = false;
    return { ...selection, version: version ?? selection.version, available: version !== null && intact, compatible,
      ...(protocol ? { protocol } : {}), ...(protocolError ? { protocolError } : {}) };
  }
  private async probe(command: string): Promise<string | null> {
    try {
      const info = await stat(command);
      const physicalPath = await physicalCodexPath(command);
      const native = await stat(physicalPath);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.mode}:${info.ctimeMs}:${physicalPath}:${native.ino}:${native.size}:${native.mtimeMs}:${native.ctimeMs}`;
      const cached = this.probeCache.get(command);
      if (cached?.stamp === stamp && Date.now() - cached.checkedAt < 30_000) return cached.version;
      const version = this.options.probe ? await this.options.probe(command) :
        /^codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m.exec((await executeFile(command, ["--version"], {
          timeout: 5_000, maxBuffer: 4096, env: this.environment
        })).stdout)?.[1] || null;
      this.probeCache.set(command, { stamp, version, checkedAt: Date.now() }); return version;
    } catch { return null; }
  }
  private protectedIds(state: RuntimeState, leases: RuntimeLease[], effectiveSelection?: CliSelection | null): Set<string | null> {
    return new Set([state.activeId, state.stagedId, state.recoveryId, ...state.managed.filter(item =>
      item.version === state.preferences.pinnedVersion || this.managedCommand(item) === state.selection?.command ||
      this.managedCommand(item) === effectiveSelection?.command || this.managedCommand(item) === effectiveSelection?.physicalPath ||
      this.managedCommand(item) === state.pendingSelection?.command || leases.some(lease => lease.selection.command === this.managedCommand(item))
    ).map(item => item.id)]);
  }
  private async liveLeases(): Promise<RuntimeLease[]> {
    const directory = path.join(this.root, "leases");
    const leases: RuntimeLease[] = [];
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const file = path.join(directory, name);
      try {
        const value = z.object({ pid: z.number().int().positive(), selection: selectionSchema, startedAt: z.string() }).parse(
          parseJsonUtf8Strict(await readFile(file), "runtime lease")
        );
        if (pidAlive(value.pid)) leases.push(value); else await rm(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CODEX_LEASE_INVALID: Cannot safely determine whether a runtime is in use.");
      }
    }
    return leases;
  }
  private async readState(): Promise<RuntimeState> {
    try {
      const state = stateSchema.parse(
        parseJsonUtf8Strict(await readFile(path.join(this.root, "cli-state.json")), "runtime state")
      );
      if (state.operation && ["downloading", "installing", "verifying"].includes(state.operation.phase) && !pidAlive(state.operation.ownerPid)) {
        state.operation = { ...state.operation, phase: "failed", error: "CODEX_INSTALL_INTERRUPTED" };
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CODEX_STATE_INVALID: Saved runtime selection needs repair; no automatic fallback was made.");
      return { schemaVersion: 1, selection: null, selectionRequired: false, selectionRevision: 0, stagedSelectionRevision: null, pendingSelection: null, managed: [], activeId: null,
        stagedId: null, recoveryId: null, preferences: preferencesSchema.parse({}), latestVersion: null, checkedAt: null, lastSuccessfulCheckAt: null, updateCheckError: null, operation: null };
    }
  }
  private async changeState(change: (state: RuntimeState) => void | Promise<void>): Promise<void> {
    await withRuntimeLock(this.root, "cli", async () => {
      const state = await this.readState();
      await change(state);
      await atomicRuntimeJson(path.join(this.root, "cli-state.json"), stateSchema.parse(state));
      for (const listener of this.changeListeners) listener();
    });
  }
}

export async function atomicRuntimeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function withRuntimeLock<T>(root: string, name: string, task: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lock = path.join(root, `.${name}-lock`);
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; await writeFile(path.join(lock, "pid"), String(process.pid), { mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(path.join(lock, "pid"))
        .then((data) => decodeUtf8Strict(data, "runtime lock owner"))
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0";
          throw error;
        }));
      if (owner > 0 && !pidAlive(owner)) { await rm(lock, { recursive: true, force: true }); continue; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!acquired) throw new Error("CODEX_OPERATION_BUSY: Runtime settings are being changed.");
  try { return await task(); } finally { await rm(lock, { recursive: true, force: true }); }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}
export async function fileDigest(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
function selectionId(physicalPath: string): string { return createHash("sha256").update(physicalPath).digest("hex").slice(0, 24); }
function operation(action: string, phase: NonNullable<RuntimeState["operation"]>["phase"], version?: string): NonNullable<RuntimeState["operation"]> {
  return { action, phase, ...(version ? { version } : {}), ownerPid: process.pid, error: null, updatedAt: new Date().toISOString() };
}
function newerThan(candidate: string, current: string | null): boolean {
  if (!current) return false;
  const a = candidate.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
async function latestStableCli(): Promise<string> {
  const response = await fetch("https://registry.npmjs.org/@openai/codex/latest", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("CODEX_UPDATE_CHECK_FAILED: The version service is unavailable.");
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 1024 * 1024) throw new Error("CODEX_UPDATE_CHECK_FAILED: The version service returned too much data.");
  const metadata = parseJsonUtf8Strict<{ version?: unknown }>(body, "Codex update metadata");
  if (typeof metadata.version !== "string") throw new Error("CODEX_UPDATE_CHECK_FAILED: The version service returned invalid data.");
  return metadata.version;
}
function resolveOnPath(command: string, environment: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command) || command.includes(path.sep)) return path.resolve(command);
  for (const directory of (environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, command);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next PATH entry */ }
  }
  throw new Error("CODEX_SELECTION_UNAVAILABLE: The explicitly configured executable was not found.");
}
function physicalCodexPath(command: string): string {
  const resolved = realpathSync(command);
  // The official npm JS launcher and its packaged native executable are one installation.
  if (resolved.endsWith(`${path.sep}bin${path.sep}codex.js`) || (process.platform === "win32" && resolved.endsWith(`${path.sep}codex.cmd`))) {
    const packageRoot = resolved.endsWith(".cmd") ? path.join(path.dirname(resolved), "node_modules", "@openai", "codex") : path.dirname(path.dirname(resolved));
    try {
      const metadata = parseJsonUtf8Strict<Record<string, unknown>>(
        readFileSync(path.join(packageRoot, "package.json")),
        "Codex package metadata"
      );
      if (metadata.name === "@openai/codex") {
        const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
        const executable = `codex${process.platform === "win32" ? ".exe" : ""}`;
        for (const root of [path.join(packageRoot, "node_modules", "@openai", `codex-${process.platform}-${process.arch}`),
          path.join(path.dirname(packageRoot), `codex-${process.platform}-${process.arch}`), packageRoot]) {
          for (const directory of ["bin", "codex"]) {
            try { return realpathSync(path.join(root, "vendor", target, directory, executable)); } catch { /* another official package layout */ }
          }
        }
      }
    } catch { /* standalone executable */ }
  }
  return resolved;
}

function fileStamp(file: string): string {
  const info = statSync(file);
  return `${info.dev}:${info.ino}:${info.size}:${info.mode}:${info.mtimeMs}:${info.ctimeMs}`;
}

function canonicalRuntimePath(file: string): string {
  let candidate = file;
  const missing: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(candidate), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return file;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function assertCompatibleSelection(candidate: CliCandidate): void {
  if (!candidate.compatible) throw new Error(
    `CODEX_PROTOCOL_UNSUPPORTED: The selected CLI does not provide the required App Server contract (${candidate.protocol?.missingCore.join(", ") || candidate.protocolError || "unverified"}). Choose or repair an installation before starting work.`
  );
}
