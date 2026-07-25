import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';

export type CephConnectionState = 'NotConfigured' | 'Ready' | 'Degraded' | 'Blocked';

export interface CephProviderGuide {
  schemaVersion: number;
  rookVersion: string;
  consumerNamespace: string;
  requiredInformation: Array<{ id: string; label: string; description: string; secret: boolean }>;
  requiredPreparation: Array<{ id: string; label: string; description: string }>;
  network: { monitorTcpPorts: number[]; cephDaemonTcpRange: string; sourceScope: string };
  unsupportedInputs: string[];
}

export const CEPH_PROVIDER_GUIDE: CephProviderGuide = {
  schemaVersion: 2,
  rookVersion: 'v1.20.2',
  consumerNamespace: 'rook-ceph',
  requiredInformation: [
    { id: 'fsid', label: 'Cluster ID (FSID)', description: '대상 Ceph 클러스터를 유일하게 식별하는 UUID', secret: false },
    { id: 'mon-endpoints', label: 'MON endpoint', description: '각 Monitor의 public-network 주소와 포트(msgr2 3300 권장, msgr1 6789 지원)', secret: false },
    { id: 'user-id', label: 'CephX 사용자', description: 'Ceph 엔티티(client.<id>) 또는 ceph-csi userID(<id>). 시스템이 대상별 형식으로 변환', secret: false },
    { id: 'user-key', label: 'User key', description: 'CephX 사용자 인증 key. Kubernetes Secret에만 저장', secret: true },
    { id: 'pool', label: 'RBD pool', description: 'Kubernetes 볼륨에 사용할 기존 RBD pool 이름', secret: false },
  ],
  requiredPreparation: [],
  network: { monitorTcpPorts: [3300, 6789], cephDaemonTcpRange: '6800-7568', sourceScope: 'all-consumer-kubernetes-nodes' },
  unsupportedInputs: ['client.admin keyring', 'monitor keyring', 'RGW/object-store credentials', 'Ceph dashboard credentials'],
};

export interface CephStatus {
  state: CephConnectionState;
  reason: string;
  message: string;
  checkedAt: string;
  providerGuide?: CephProviderGuide;
  kubernetes: { ready: boolean; id?: string; version?: string; nodes?: number; readyNodes?: number };
  connection: null | {
    mode: 'RookExternal';
    fsidFingerprint: string;
    secretRefs: string[];
    connectedBy: string;
    connectedAt: string;
    chartVersion: string;
  };
  rook?: {
    operator: { installed: boolean | null; status: string; chart: string; revision: number; reason?: string };
    cluster: { installed: boolean | null; status: string; chart: string; revision: number; reason?: string };
    cephCluster: null | { state: string; health: string };
  };
  csi?: {
    drivers: string[];
    storageClasses: Array<{ name: string; provisioner: string; reclaimPolicy: string }>;
  };
  ownerPrerequisites?: {
    ready: boolean;
    blockers: string[];
    missingPermissions: string[];
    operatorReady: boolean;
    cephClusterCrdReady: boolean;
    snapshotApiReady: boolean;
    namespaces?: { runtime: boolean; imports: boolean };
    policy?: { operatorOwner: string; runtimeOwner: string; importTransport: string };
    installationRequest?: CephPrerequisiteRequest | null;
  };
}

export interface CephPlan {
  mode: 'RookExternal';
  namespace: string;
  parent: 'Kubernetes';
  clusterID: string;
  fsidFingerprint: string;
  monitors: string[];
  monitorCount: number;
  monitorProtocols?: string[];
  cephEntity: string;
  csiUserID: string;
  /** @deprecated csiUserID 호환 별칭 */
  userID: string;
  storage: Array<{ name: string; pool: string; filesystem: string }>;
  secretRefs: string[];
  charts: Array<{ release: string; chart: string; version: string; valuesProfile?: string }>;
  resources: Array<{ kind: string; namespace: string; name: string; secretRefOnly?: boolean; reclaimPolicy?: string; deletionPolicy?: string }>;
  ignoredProviderResources: string[];
  snapshotSupported: boolean;
  providerGuide?: CephProviderGuide;
  safety: {
    rawCredentialsPersistedByConsole: boolean;
    remotePoolsModified: boolean;
    remoteDataDeletedOnDisconnect: boolean;
    reclaimPolicy: string;
  };
}

export interface CephImport {
  importRef: string;
  fsidFingerprint: string;
  monitorCount: number;
  storageClasses: string[];
  expiresAt: string;
  secretValuesReturned: false;
}

export interface CephConnectionInput {
  clusterID: string;
  monitors: string;
  userID: string;
  userKey: string;
  pool: string;
  storageClassName: string;
}

export interface CephPrerequisiteRequest {
  accepted?: boolean;
  duplicate?: boolean;
  trackingAvailable?: boolean;
  requestId?: string;
  phase?: 'Creating' | 'AwaitingApproval' | 'Queued' | 'Applying' | 'Completed' | 'Failed' | 'NeedsAttention' | 'Unavailable';
  status?: string;
  message?: string;
  reason?: string;
  source?: string;
  requestedAt?: string;
  completedAt?: string;
  checkedAt?: string;
  pullRequest?: { number?: number; url?: string | null; htmlUrl?: string | null } | null;
  reconciler?: string | null;
  reconcilerStatus?: string;
  outboxStatus?: string | null;
  attemptCount?: number;
  approvalCount?: number;
  lastError?: string | null;
}

export interface CephInsights {
  schemaVersion: 1;
  observedAt: string;
  durationMs: number;
  cached: boolean;
  cacheAgeSeconds: number;
  partial: boolean;
  capabilities: string[];
  cluster: {
    health: string;
    fsidFingerprint: string;
    monitors: number;
    managers: { active: string; standbys: number };
    versions: Array<{ daemonType: string; version: string; count: number }>;
  };
  capacity: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percentUsed: number;
  };
  pools: Array<{
    id: number;
    name: string;
    bytesUsed: number;
    storedBytes: number;
    maxAvailableBytes: number;
    objects: number;
    percentUsed: number;
  }>;
  osds: {
    total: number;
    up: number;
    down: number;
    in: number;
    out: number;
    averageUtilization: number;
    maxUtilization: number;
    items: Array<{
      id: number;
      name: string;
      host: string;
      status: string;
      in: boolean;
      deviceClass: string;
      utilization: number;
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
    }>;
    byHost: Array<{
      name: string;
      osds: number;
      up: number;
      in: number;
      totalBytes: number;
      usedBytes: number;
      utilization: number;
    }>;
  };
  pgs: {
    total: number;
    healthy: number;
    unhealthy: number;
    states: Array<{ state: string; count: number }>;
  };
  hosts: Array<{ hostname: string; address: string; labels: string[]; status: string }>;
  services: Array<{
    type: string;
    id: string;
    hostname: string;
    status: number;
    statusDescription: string;
    version: string;
    lastRefresh: string;
  }>;
  sectionErrors: Array<{ section: string; reason: string; message: string }>;
}

@Injectable({ providedIn: 'root' })
export class CephService {
  private http = inject(HttpClient);

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private url(path: string): string { return `${this.base()}/api/ceph/${path}`; }

  status(): Observable<CephStatus> { return this.http.get<CephStatus>(this.url('oaa/status')); }
  insights(refresh = false): Observable<CephInsights> {
    return this.http.get<CephInsights>(this.url(`oaa/insights${refresh ? '?refresh=1' : ''}`));
  }
  requestPrerequisites(reason: string, source: string): Observable<CephPrerequisiteRequest> {
    return this.http.post<CephPrerequisiteRequest>(this.url('prerequisites/request'), { reason, source });
  }
  plan(connection: CephConnectionInput): Observable<CephPlan> {
    return this.http.post<CephPlan>(this.url('plan'), { connection });
  }
  stage(connection: CephConnectionInput, reason: string): Observable<CephImport> {
    return this.http.post<CephImport>(this.url('imports'), { connection, reason, confirm: 'stage Ceph connection' });
  }
  connect(connection: CephConnectionInput, reason: string): Observable<{ ok: boolean; status: CephStatus }> {
    return this.stage(connection, reason).pipe(switchMap((staged) => this.connectImport(staged.importRef, reason)));
  }
  connectImport(importRef: string, reason: string): Observable<{ ok: boolean; status: CephStatus }> {
    const confirm = `connect Ceph external storage using ${importRef}`;
    return this.http.post<{ ok: boolean; status: CephStatus }>(this.url('oaa/connect'), { importRef, reason, confirm });
  }
  disconnect(reason: string): Observable<{ ok: boolean; retained: string[]; removed: string[] }> {
    const confirm = 'disconnect Ceph external storage';
    return this.http.post<{ ok: boolean; retained: string[]; removed: string[] }>(this.url('oaa/disconnect'), { reason, confirm });
  }
}
