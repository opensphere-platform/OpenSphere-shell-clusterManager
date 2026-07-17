import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type CephConnectionState = 'NotConfigured' | 'Ready' | 'Degraded' | 'Blocked';

export interface CephStatus {
  state: CephConnectionState;
  reason: string;
  message: string;
  checkedAt: string;
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
    operator: { installed: boolean; status: string; chart: string; revision: number };
    cluster: { installed: boolean; status: string; chart: string; revision: number };
    cephCluster: null | { state: string; health: string };
  };
  csi?: {
    drivers: string[];
    storageClasses: Array<{ name: string; provisioner: string; reclaimPolicy: string }>;
  };
}

export interface CephPlan {
  mode: 'RookExternal';
  namespace: string;
  parent: 'Kubernetes';
  fsidFingerprint: string;
  monitorCount: number;
  storage: Array<{ name: string; pool: string; filesystem: string }>;
  secretRefs: string[];
  charts: Array<{ release: string; chart: string; version: string; valuesProfile?: string }>;
  resources: Array<{ kind: string; namespace: string; name: string; secretRefOnly?: boolean; reclaimPolicy?: string; deletionPolicy?: string }>;
  ignoredProviderResources: string[];
  snapshotSupported: boolean;
  safety: {
    rawCredentialsPersistedByConsole: boolean;
    remotePoolsModified: boolean;
    remoteDataDeletedOnDisconnect: boolean;
    reclaimPolicy: string;
  };
}

@Injectable({ providedIn: 'root' })
export class CephService {
  private http = inject(HttpClient);

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private url(path: string): string { return `${this.base()}/api/ceph/${path}`; }

  status(): Observable<CephStatus> { return this.http.get<CephStatus>(this.url('status')); }
  plan(providerExport: string): Observable<CephPlan> { return this.http.post<CephPlan>(this.url('plan'), { providerExport }); }
  connect(providerExport: string, reason: string): Observable<{ ok: boolean; status: CephStatus }> {
    return this.http.post<{ ok: boolean; status: CephStatus }>(this.url('connect'), { providerExport, reason });
  }
  disconnect(reason: string, confirm: string): Observable<{ ok: boolean; retained: string[]; removed: string[] }> {
    return this.http.post<{ ok: boolean; retained: string[]; removed: string[] }>(this.url('disconnect'), { reason, confirm });
  }
}
