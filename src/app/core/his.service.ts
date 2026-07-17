import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type HisState = 'Ready' | 'Blocked' | 'Degraded';
export type HisMode = 'DetectOnly' | 'HelmManaged';

export interface HisComponentDetail {
  name: string;
  kind: string;
  resourceName: string;
  namespace: string;
  state: 'Ready' | 'Pending' | 'Missing';
  desired: number;
  ready: number;
  image: string;
}

export interface HisOperation {
  id: string;
  itemId: string;
  displayName: string;
  action: 'install' | 'uninstall';
  phase: 'Queued' | 'Recovering' | 'Installing' | 'Validating' | 'Uninstalling' | 'Ready' | 'Removed' | 'Failed' | 'RollbackStalled';
  progress: number;
  message: string;
  error: string;
  actor: string;
  worker: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string;
  releaseStatus?: string;
}

export interface HisCheck {
  state: HisState;
  reason: string;
  message: string;
  observedVersion: string;
  retryable: boolean;
  lastCheckedAt: string;
  details?: {
    components?: HisComponentDetail[];
    crds?: { ready: number; total: number; items: Array<{ name: string; ready: boolean }> };
    pvcs?: Array<{ name: string; phase: string; requested: string; capacity: string; storageClass: string }>;
    services?: Array<{ name: string; type: string; clusterIP: string; ports: string }>;
  };
}

export interface HisItem {
  id: string;
  displayName: string;
  description: string;
  mode: HisMode;
  required: boolean;
  profile?: string;
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  source?: string;
  namespace?: string;
  release?: { managed: boolean; status: string; revision: number } | null;
  operation?: HisOperation | null;
  operationalProfile?: {
    components: string[];
    storage: string[];
    retention: string[];
    exposure: string;
  };
  ownership: 'ClusterManager' | 'External' | 'Unmanaged' | 'Unknown';
  retainedOnDelete?: string[];
  check: HisCheck;
}

export interface HisStatus {
  stack: 'HIS';
  state: HisState;
  checkedAt: string;
  items: HisItem[];
}

export interface HisPlan {
  id: string;
  displayName: string;
  chart: string;
  chartVersion: string;
  namespace: string;
  release: string;
  clusterVariant: string;
  retainedOnDelete: string[];
  summary: {
    workloads: number;
    services: number;
    persistentVolumeClaims: number;
    customResourceDefinitions: number;
    byKind: Record<string, number>;
  };
  operationalProfile?: HisItem['operationalProfile'];
  resources: Array<{ apiVersion: string; kind: string; namespace: string; name: string }>;
}

@Injectable({ providedIn: 'root' })
export class HisService {
  private http = inject(HttpClient);

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private url(path: string): string { return `${this.base()}/api/his/${path}`; }

  status(): Observable<HisStatus> { return this.http.get<HisStatus>(this.url('status')); }
  plan(id: string): Observable<HisPlan> { return this.http.post<HisPlan>(this.url('plan'), { id }); }
  install(id: string, reason: string): Observable<{ ok: boolean; operation: HisOperation }> { return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('install'), { id, reason }); }
  uninstall(id: string, reason: string, confirm: string): Observable<{ ok: boolean; operation: HisOperation }> {
    return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('uninstall'), { id, reason, confirm });
  }
}
