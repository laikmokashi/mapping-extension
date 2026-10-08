import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const ORIGIN_TYPE = 'TopologyMap';
const SUB_TYPE = 'topology-map';
const REST_SEGMENT = 'extensions/topology-maps';

export interface TopologyCountSummary { regions: number; vpcs: number; subnets: number; resources: number; edges: number; }
export interface TopologyScanWarning { service?: string; region?: string; code?: string; message?: string; missingPermission?: string; }
export interface TopologyMapResult {
  latestSnapshotId?: string;
  lastScanStartedAt?: string;
  lastScanCompletedAt?: string;
  durationSeconds?: number;
  nextScanDueAt?: string;
  scannedRegions?: string[];
  counts?: TopologyCountSummary;
  countsByType?: Record<string, number>;
  countsByRegion?: Record<string, number>;
  scanWarnings?: TopologyScanWarning[];
  warnings?: string[];
  faults?: string[];
}
export interface TopologyMapSpec {
  awsScopeId?: string;
  accountId?: string;
  callerArn?: string;
  regions?: string[];
  resourceTypes?: string[];
  refreshIntervalMinutes?: number;
  scopeIds?: string[];
}
export interface TopologyMap {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  blockedReason?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  workerState?: { retryCount?: number; lastAttemptAt?: string; nextAttemptAt?: string; lastVerifiedAt?: string; lastFailedCode?: string };
  spec?: TopologyMapSpec;
  result?: TopologyMapResult;
}

export interface TopologyNode {
  id: string; type: string; label?: string; parentId?: string; region?: string;
  properties?: Record<string, any>; tags?: Record<string, string>; securityGroupIds?: string[];
  consoleUrl?: string; spansSubnetIds?: string[]; isStopped?: boolean;
  childCount?: number; childCountsByType?: Record<string, number>;
}
export interface TopologyEdge { id: string; type: string; source: string; target: string; label?: string; count?: number; }
export interface GraphResponse { snapshotId?: string; nodes: TopologyNode[]; edges: TopologyEdge[]; truncated?: boolean; }
export interface AccountLookupResponse { accountId?: string; callerArn?: string; regions?: string[]; error?: string; }

export interface Scope { id: string; name: string; }

@Injectable({ providedIn: 'root' })
export class TopologyService {
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string { return this.session?.tenant?.TenantId ?? ''; }
  private base() { return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`; }
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<TopologyMap[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as TopologyMap[];
    }));
  }

  get(id: string): Observable<TopologyMap> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: Partial<TopologyMapSpec>): Observable<TopologyMap> {
    return this.http.post(this.base(), { name, spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  update(id: string, spec: Partial<TopologyMapSpec>): Observable<TopologyMap> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  deprovision(id: string): Observable<void> {
    return this.http.post(`${this.base()}/${id}/deprovision`, {});
  }

  delete(id: string): Observable<void> {
    return this.http.delete(`${this.base()}/${id}`);
  }

  refresh(id: string): Observable<void> {
    return this.http.post(`${this.base()}/${id}/refresh`, {}).pipe(map(() => void 0));
  }

  graph(id: string, params?: { depth?: string; expanded?: string; collapsed?: string; edgeTypes?: string; types?: string; regions?: string; focus?: string; hops?: number }): Observable<GraphResponse> {
    let url = `${this.base()}/${id}/graph`;
    if (params) {
      const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
      if (qs) url += '?' + qs;
    }
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)));
  }

  getNode(id: string, nodeId: string): Observable<{ node: TopologyNode; edges: TopologyEdge[] }> {
    return this.http.get(`${this.base()}/${id}/nodes/${encodeURIComponent(nodeId)}`).pipe(map((r: any) => this.unwrap(r)));
  }

  searchNodes(id: string, q: string): Observable<TopologyNode[]> {
    return this.http.get(`${this.base()}/${id}/search?q=${encodeURIComponent(q)}`).pipe(map((r: any) => this.unwrap(r) ?? []));
  }

  inventory(id: string, q?: string, page = 1, pageSize = 50): Observable<{ items: any[]; total: number }> {
    let url = `${this.base()}/${id}/inventory?page=${page}&pageSize=${pageSize}`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r) ?? { items: [], total: 0 }));
  }

  accountLookup(scopeId: string): Observable<AccountLookupResponse> {
    return this.http.post(`${this.base()}/account-lookup`, { scopeId }).pipe(map((r: any) => this.unwrap(r)));
  }

  listScopes(): Observable<Scope[]> {
    return this.http.get(
      `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/scopes`
    ).pipe(map((r: any) => {
      // Response shape: { success, data: [...] } or plain array
      const raw = r?.data ?? r;
      const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? []);
      return items
        .filter((s: any) => s.awsResourceSearchFilter != null)
        .map((s: any) => ({ id: s.id, name: s.name }));
    }));
  }
}
