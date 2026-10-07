import { Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FilterTableUtils, SearchableDatatableComponent, SearchableDatatableModule } from '@duplocloud-internal/ng-common-lib';
import { TopologyService, TopologyMap, REMOTE_UserSession } from '../topology.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

@Component({
  selector: 'topo-list',
  imports: [SearchableDatatableModule, StatusBadgeComponent, DatePipe],
  template: `
    <div class="card datatable-card">
      <searchable-datatable
        [showAdd]="true"
        addLabel="Create Topology Map"
        (add)="add()"
        [rows]="rows()"
        (filter)="filterUpdate()"
        columnMode="force">

        <ngx-datatable-column [width]="50" [sortable]="false" [canAutoResize]="false" cellClass="actions">
          <ng-template ngx-datatable-cell-template let-row="row">
            <div ngbDropdown container="body">
              <button class="btn btn-sm hide-arrow" ngbDropdownToggle>
                <i data-feather="more-vertical"></i>
              </button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="viewItem(row)">
                  <i data-feather="eye" class="mr-50"></i><span>View</span>
                </a>
                <a ngbDropdownItem (click)="openMap(row)">
                  <i data-feather="map" class="mr-50"></i><span>Open Map</span>
                </a>
                <a ngbDropdownItem class="text-danger" (click)="deprovision(row)">
                  <i data-feather="trash-2" class="mr-50"></i><span>Deprovision</span>
                </a>
              </div>
            </div>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Name" [flexGrow]="160">
          <ng-template ngx-datatable-cell-template let-row="row">
            <a (click)="viewItem(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Account ID" [flexGrow]="130">
          <ng-template ngx-datatable-cell-template let-row="row">
            <span class="mono text-sm">{{ row.spec?.accountId || '—' }}</span>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Regions" [flexGrow]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (row.spec?.regions?.length) {
              {{ row.spec.regions.join(', ') }}
            } @else {
              <span class="text-muted">All regions</span>
            }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Resources" [flexGrow]="90">
          <ng-template ngx-datatable-cell-template let-row="row">
            {{ row.result?.counts?.resources ?? '—' }}
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Last Scanned" [flexGrow]="140">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (row.result?.lastScanCompletedAt) {
              {{ row.result.lastScanCompletedAt | date:'short' }}
            } @else {
              <span class="text-muted">Not yet</span>
            }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Warnings" [flexGrow]="80">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (row.result?.scanWarnings?.length) {
              <span class="badge badge-warning">{{ row.result.scanWarnings.length }}</span>
            } @else {
              <span class="text-muted">0</span>
            }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Status" [flexGrow]="110" [maxWidth]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            <app-status-badge [status]="row.status"></app-status-badge>
          </ng-template>
        </ngx-datatable-column>

      </searchable-datatable>
    </div>
  `,
})
export class ListTopologyMapComponent implements OnInit {
  private readonly svc = inject(TopologyService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject<any>(REMOTE_UserSession as any);
  private readonly destroyRef = inject(DestroyRef);

  private readonly table = viewChild(SearchableDatatableComponent);
  private readonly allRows = signal<TopologyMap[]>([]);
  private readonly filterTerm = signal('');

  private readonly searchFields = ['name', 'status', 'spec.accountId', 'spec.regions'];

  protected readonly rows = computed(() => {
    const term = this.filterTerm();
    const all = this.allRows();
    return term ? all.filter(r => FilterTableUtils.searchByFields(r, this.searchFields, term)) : all;
  });

  ngOnInit(): void {
    this.session.getTenantRefreshTimer(true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([, tenantChanged]: [any, boolean]) => this.refresh(!!tenantChanged));
  }

  private refresh(tenantChanged: boolean): void {
    if (tenantChanged) {
      this.table()?.startLoading();
    }
    this.svc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: rows => {
        this.allRows.set(rows ?? []);
        this.table()?.refresh();
      },
      error: () => {
        this.allRows.set([]);
        this.table()?.stopLoading();
      },
    });
  }

  protected filterUpdate(): void {
    this.filterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected add(): void {
    this.router.navigate(['add'], { relativeTo: this.route });
  }

  protected viewItem(r: TopologyMap): void {
    this.router.navigate(['view', r.id], { relativeTo: this.route });
  }

  protected openMap(r: TopologyMap): void {
    this.router.navigate([r.id, 'map'], { relativeTo: this.route });
  }

  protected deprovision(r: TopologyMap): void {
    if (confirm(`Deprovision "${r.name}"? This deletes all snapshots.`)) {
      this.svc.deprovision(r.id).subscribe({ next: () => this.refresh(false) });
    }
  }
}
