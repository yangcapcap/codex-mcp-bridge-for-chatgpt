import {types as contextTypes} from "node:util";
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownResult} from "./shutdown.js";
import { executionEndpoint } from "./executionTransport.js";
import { CodexService } from "./codexService.js";
import type { CodexUpstream } from "./upstream.js";
import type { CodexBackendKind } from "./config.js";
import type { BridgeConfig } from "./config.js";
import { CodexRuntimeManager, observeRetainedCliLease } from "./codexRuntime.js";
import { CodexAppServerUpstreamPool, type CodexAppServerProtocolOptions } from "./appServerUpstream.js";
import { CodexBackendRouter } from "./upstreamRouter.js";
import { LazyCodexUpstream } from "./lazyUpstream.js";
import { UNVERIFIED_APP_SERVER_CAPABILITIES } from "./cliProtocol.js";
import { codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import {
  ChildProcessCodexExecutionService,
  type CodexExecutionServiceHealth,
  type ExecutorExitReason,
  type WorkerObservationIncident
} from "./executionServiceProcess.js";

export type ExecutionRuntimeIsolationOptions = {
  isolateCodexExecution?: boolean;
  /** Test/diagnostic hook; never exposed through public status payloads. */
  onExecutionProcessSpawn?: (processId: number) => void;
  onExecutionObservationIncident?: (incident: WorkerObservationIncident) => void;
  onExecutionExitIntent?: (reason: ExecutorExitReason) => void;
};

export function createExecutionRuntime(
  config: BridgeConfig,
  options: CodexAppServerProtocolOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
  isolation: ExecutionRuntimeIsolationOptions = {}
): CodexBackendRouter {
  const codexEnvironment = codexProcessEnvironment(environment);
  const manager = new CodexRuntimeManager({ environment: codexEnvironment, explicitCommand: codexEnvironment.CODEX_MCP_BRIDGE_CODEX || codexEnvironment.CODEX_GPT_BRIDGE_CODEX ||
    (config.codexCommand !== "codex" ? config.codexCommand : undefined) });
  const service = config.codexService = new CodexService(codexEnvironment, manager);
  let selected: Promise<string> | undefined;
  let release: (() => Promise<void>) | undefined;
  let selectionPending=false,selectionResolved=false,selectionUnconfirmed=false,leaseReleaseStarted=false;
  const retainedContexts:unknown[]=[];
  const resolveCli = (): Promise<string> => {
    if (!selected) {
      selectionPending=true;
      selected=service.acquireContext().then(context=>{
        retainedContexts.push(context);
        if(constructionPinned)throw new Error('NONFORCING_EXECUTION_CONSTRUCTION_CLOSED');
        if(!context || typeof context!=='object' || contextTypes.isProxy(context))throw new Error('CLI_CONTEXT_OWNER_UNCONFIRMED');
        const fields=Object.getOwnPropertyDescriptors(context);
        const ownedRelease=fields.release,ownedSelection=fields.selection;
        if(!ownedRelease || !('value' in ownedRelease) || typeof ownedRelease.value!=='function' ||
          !ownedSelection || !('value' in ownedSelection) || !ownedSelection.value || typeof ownedSelection.value!=='object' ||
          contextTypes.isProxy(ownedSelection.value))throw new Error('CLI_CONTEXT_OWNER_UNCONFIRMED');
        const commandField=Object.getOwnPropertyDescriptor(ownedSelection.value,'command');
        if(!commandField || !('value' in commandField) || typeof commandField.value!=='string')throw new Error('CLI_CONTEXT_OWNER_UNCONFIRMED');
        if(constructionPinned)throw new Error('NONFORCING_EXECUTION_CONSTRUCTION_CLOSED');
        release=ownedRelease.value;const command=commandField.value;
        selectionResolved=true;return command;
      }).catch(error=>{retainedContexts.push(error);selectionUnconfirmed=true;if(!constructionPinned)selected=undefined;throw error;})
        .finally(()=>{selectionPending=false;});
    }
    return selected;
  };
  config.runtimeStatusResolver = async () => {
    const cli = await manager.snapshot();
    const compact = (state: typeof cli) => `installed=${state.installedVersion ?? "none"}; running=${state.runningVersions.join(",") || "none"}; active=${state.managedVersions.find(item => item.active)?.version ?? "none"}; staged=${state.stagedVersion ?? "none"}; rollback=${state.recoveryVersion ?? "none"}`;
    return [`CLI: source=${cli.selection?.source ?? "unselected"}; compatible=${cli.selection?.compatible ?? "unknown"}; ${compact(cli)}`];
  };
  let executionService: ChildProcessCodexExecutionService | undefined;
  let executionStarting = false;
  let constructionPinned=false;
  const app = new LazyCodexUpstream(
    "app-server",
    UNVERIFIED_APP_SERVER_CAPABILITIES,
    async () => {
      if (!isolation.isolateCodexExecution) {
        const command = await resolveCli();
        if(constructionPinned)throw new Error("NONFORCING_EXECUTION_CONSTRUCTION_CLOSED");
        return new CodexAppServerUpstreamPool(
          command,
          config.upstreamPoolSize,
          { ...options, environment: codexEnvironment }
        );
      }
      executionStarting = true;
      try {
        const command = await resolveCli();
        if(constructionPinned)throw new Error("NONFORCING_EXECUTION_CONSTRUCTION_CLOSED");
        executionService = await ChildProcessCodexExecutionService.start({
          command,
          endpoint: executionEndpoint(config.stateDatabaseFile),
          poolSize: config.upstreamPoolSize,
          environment: codexEnvironment,
          protocolOptions: options,
          onLateResponse: options.onLateResponse,
          onProcessSpawn: isolation.onExecutionProcessSpawn,
          onObservationIncident: isolation.onExecutionObservationIncident,
          onExitIntent: isolation.onExecutionExitIntent
        });
        return executionService;
      } finally {
        executionStarting = false;
      }
    },
    undefined,
    service.admissionGuard(),
    ()=>{constructionPinned=true;return true;}
  );
  const router = new CodexBackendRouter("app-server", new Map<CodexBackendKind, CodexUpstream>([["app-server", app]]));
  service.setAccountReader(() => app.readAccountSnapshot());
  service.setAuthPolicyReader(() => app.readAuthenticationPolicy());
  if (isolation.isolateCodexExecution) {
    router.supportsExecutionRecovery = () => true;
    router.executionHealth = (): CodexExecutionServiceHealth =>
      executionService?.health() || {
        status: executionStarting ? "starting" : "idle",
        inFlight: 0,
        capacity: 128
      };
  }
  router.accountRevision = () => service.cacheRevision();
  router.readAccountSnapshot = () => service.readAccount(config.defaultBackend);
  router.readAccountRateLimits = async () => {
    const account = await service.readAccount(config.defaultBackend);
    const window = account?.windows.find(window => window.limitId === "codex" && window.windowDurationMins === 10080);
    return account && window ? { ...window, observedAt: account.observedAt } : null;
  };
  const close = router.close.bind(router),closeNonforcing=router.closeNonforcing.bind(router),observe=router.observeNonforcingExit.bind(router);
  let nonforcingClose:Promise<ShutdownResult>|undefined,leaseUnconfirmed=false;
  const currentNonforcingClose=()=>nonforcingClose;
  router.closeNonforcing=policy=>{
    const supplied=snapshotShutdownPolicy(policy);if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
    if(nonforcingClose)return nonforcingClose;
    let finish!:(value:ShutdownResult)=>void;nonforcingClose=new Promise(resolve=>finish=resolve);
    constructionPinned=true;
    leaseUnconfirmed=selectionUnconfirmed || leaseReleaseStarted || selectionPending || Boolean(selected && (!selectionResolved || !observeRetainedCliLease(release)));
    const resource=closeNonforcing({...supplied,allowSigkillEscalation:false});
    void boundedShutdown(()=>resource,supplied.graceMs*2+6000).then(result=>finish(combineShutdown([result,retainedLeaseObservation()])));
    return nonforcingClose;
  };
  const retainedLeaseObservation=()=>{
    if(release&&!observeRetainedCliLease(release))leaseUnconfirmed=true;
    return leaseUnconfirmed?shutdownResult('uncertain'):shutdownResult('exited');
  };
  router.observeNonforcingExit=async()=>combineShutdown([await observe(),retainedLeaseObservation()]);
  router.close = async () => {
    if(nonforcingClose){if(!(await nonforcingClose).exited || !(await router.observeNonforcingExit()).exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');return;}
    await close();const pinnedClose=currentNonforcingClose();if(pinnedClose){if(!(await pinnedClose).exited || !(await router.observeNonforcingExit()).exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');return;}
    if(release){leaseReleaseStarted=true;await release();}
  };
  return router;
}
