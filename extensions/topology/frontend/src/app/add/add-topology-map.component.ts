import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormGroupErrorsComponent, SharedFormsModule } from '@duplocloud-internal/ng-common-lib';
import { NgSelectModule } from '@ng-select/ng-select';
import { TopologyService, TopologyMapSpec, AccountLookupResponse } from '../topology.service';

const ALL_RESOURCE_TYPES = [
  'internet-gateway', 'nat-gateway', 'vpc-endpoint', 'transit-gateway',
  'ec2', 'load-balancer', 'rds', 'elasticache', 'lambda', 'ecs', 'eks',
  's3', 'sqs', 'sns', 'dynamodb',
];

const REFRESH_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
  { value: 1440, label: '24 hours' },
];

@Component({
  selector: 'topo-add',
  imports: [SharedFormsModule, NgSelectModule],
  styles: [`
    :host { display: block; }
    .wizard-card { background: #fff; padding: 1.5rem; }
    .step-indicator { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; align-items: center; }
    .step-dot { width: 28px; height: 28px; border-radius: 50%; border: 2px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 600; color: #aaa; }
    .step-dot.active { border-color: #7367f0; background: #7367f0; color: #fff; }
    .step-dot.done { border-color: #28c76f; background: #28c76f; color: #fff; }
    .step-label { font-size: 0.85rem; color: #6e6b7b; margin-right: 1rem; }
    .step-label.active { color: #7367f0; font-weight: 600; }
    .step-sep { flex: 1; height: 1px; background: #ebe9f1; }
    .step-content h5 { margin-bottom: 0.75rem; font-weight: 600; }
    .review-row { display: flex; padding: 0.4rem 0; border-bottom: 1px solid #f8f8f8; }
    .review-label { width: 140px; font-weight: 600; font-size: 0.85rem; color: #6e6b7b; flex-shrink: 0; }
    .review-val { font-size: 0.9rem; }
    .lookup-status { font-size: 0.8rem; margin-top: 0.4rem; }
    .btn-nav { margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: flex-end; }
  `],
  template: `
    <div class="card wizard-card">
      <h4 class="font-weight-bolder mb-1">Create Topology Map</h4>

      <!-- Step indicator -->
      <div class="step-indicator">
        <div class="step-dot" [class.active]="step() === 1" [class.done]="step() > 1">1</div>
        <span class="step-label" [class.active]="step() === 1">Basics</span>
        <div class="step-sep"></div>
        <div class="step-dot" [class.active]="step() === 2" [class.done]="step() > 2">2</div>
        <span class="step-label" [class.active]="step() === 2">Coverage</span>
        <div class="step-sep"></div>
        <div class="step-dot" [class.active]="step() === 3">3</div>
        <span class="step-label" [class.active]="step() === 3">Review</span>
      </div>

      <form name="TopoAddForm" #f="ngForm" class="form form-vertical" (ngSubmit)="f.valid && finalize()">
        <div class="form-container" form-group-errors #formGroupErrors showDetailsWhen="submitted">

          <!-- Step 1: Basics -->
          @if (step() === 1) {
            <div class="step-content">
              <h5>Basics</h5>
              <form-field>
                <label class="element-label">Map Name *</label>
                <input type="text" class="form-control" name="name"
                       [ngModel]="name()" (ngModelChange)="name.set($event)"
                       placeholder="e.g. prod-account-map" required validation-state validation-errors
                       minlength="2" maxlength="60" pattern="^[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?$" />
              </form-field>

              <form-field>
                <label class="element-label">AWS Scope *</label>
                <ng-select name="scopeId"
                           [ngModel]="scopeId()" (ngModelChange)="onScopeChange($event)"
                           [items]="scopes()" bindLabel="name" bindValue="id"
                           [loading]="loadingScopes()"
                           placeholder="Select an AWS scope"
                           required validation-state validation-errors>
                </ng-select>
              </form-field>

              @if (scopeId()) {
                <div class="lookup-status">
                  @if (lookupLoading()) {
                    <span class="text-muted">Looking up account…</span>
                  } @else if (lookupError()) {
                    <span class="text-danger">{{ lookupError() }}</span>
                  } @else if (accountId()) {
                    <span class="text-success">Account: <strong>{{ accountId() }}</strong> · {{ availableRegions().length }} regions detected</span>
                  }
                </div>
              }
            </div>
          }

          <!-- Step 2: Coverage -->
          @if (step() === 2) {
            <div class="step-content">
              <h5>Coverage</h5>

              @if (availableRegions().length) {
                <form-field>
                  <label class="element-label">Regions</label>
                  <ng-select name="regions"
                             [ngModel]="selectedRegions()" (ngModelChange)="selectedRegions.set($event)"
                             [items]="availableRegions()"
                             [multiple]="true"
                             placeholder="All regions (leave empty for all)">
                  </ng-select>
                  <small class="text-muted d-block mt-50">Leave empty to scan all enabled regions.</small>
                </form-field>
              }

              <form-field>
                <label class="element-label">Resource Types</label>
                <ng-select name="resourceTypes"
                           [ngModel]="selectedTypes()" (ngModelChange)="selectedTypes.set($event)"
                           [items]="allResourceTypes"
                           [multiple]="true"
                           placeholder="All types (leave empty for all)">
                </ng-select>
                <small class="text-muted d-block mt-50">Leave empty to include all resource types.</small>
              </form-field>

              <form-field>
                <label class="element-label">Refresh Interval *</label>
                <ng-select name="refreshInterval"
                           [ngModel]="refreshInterval()" (ngModelChange)="refreshInterval.set(+$event)"
                           [items]="refreshOptions" bindLabel="label" bindValue="value"
                           [clearable]="false"
                           required>
                </ng-select>
              </form-field>
            </div>
          }

          <!-- Step 3: Review -->
          @if (step() === 3) {
            <div class="step-content">
              <h5>Review</h5>
              <div class="review-row"><span class="review-label">Map Name</span><span class="review-val">{{ name() }}</span></div>
              <div class="review-row"><span class="review-label">AWS Account</span><span class="review-val mono">{{ accountId() || scopeId() }}</span></div>
              <div class="review-row"><span class="review-label">Regions</span>
                <span class="review-val">
                  @if (selectedRegions().length) { {{ selectedRegions().join(', ') }} }
                  @else { All enabled regions }
                </span>
              </div>
              <div class="review-row"><span class="review-label">Resource Types</span>
                <span class="review-val">
                  @if (selectedTypes().length) { {{ selectedTypes().join(', ') }} }
                  @else { All types }
                </span>
              </div>
              <div class="review-row"><span class="review-label">Refresh Interval</span>
                <span class="review-val">{{ refreshLabelFor(refreshInterval()) }}</span>
              </div>
            </div>
          }

          <div class="btn-nav">
            <button type="button" class="btn btn-outline-secondary" (click)="cancel()">Cancel</button>
            @if (step() > 1) {
              <button type="button" class="btn btn-outline-secondary" (click)="step.set(step() - 1)">Back</button>
            }
            @if (step() < 3) {
              <button type="button" class="btn btn-primary" [disabled]="!canNext()" (click)="next()">Next</button>
            } @else {
              <button type="submit" class="btn btn-primary" [disabled]="saving()">
                Provision
              </button>
            }
          </div>

        </div>
      </form>
    </div>
  `,
})
export class AddTopologyMapComponent implements OnInit {
  private readonly svc = inject(TopologyService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly step = signal(1);
  protected readonly name = signal('');
  protected readonly scopeId = signal('');
  protected readonly accountId = signal('');
  protected readonly callerArn = signal('');
  protected readonly availableRegions = signal<string[]>([]);
  protected readonly selectedRegions = signal<string[]>([]);
  protected readonly selectedTypes = signal<string[]>([]);
  protected readonly refreshInterval = signal(60);
  protected readonly saving = signal(false);
  protected readonly loadingScopes = signal(false);
  protected readonly lookupLoading = signal(false);
  protected readonly lookupError = signal('');
  protected readonly scopes = signal<{ id: string; name: string }[]>([]);

  protected readonly allResourceTypes = ALL_RESOURCE_TYPES;
  protected readonly refreshOptions = REFRESH_OPTIONS;

  private readonly formErrors = viewChild(FormGroupErrorsComponent);

  ngOnInit(): void {
    this.loadingScopes.set(true);
    this.svc.listScopes().subscribe({
      next: s => { this.scopes.set(s); this.loadingScopes.set(false); },
      error: () => this.loadingScopes.set(false),
    });
  }

  protected onScopeChange(id: string): void {
    this.scopeId.set(id);
    this.accountId.set('');
    this.callerArn.set('');
    this.availableRegions.set([]);
    this.lookupError.set('');
    if (!id) return;
    this.lookupLoading.set(true);
    this.svc.accountLookup(id).subscribe({
      next: (r: AccountLookupResponse) => {
        this.lookupLoading.set(false);
        if (r.error) {
          this.lookupError.set(r.error);
        } else {
          this.accountId.set(r.accountId ?? '');
          this.callerArn.set(r.callerArn ?? '');
          this.availableRegions.set(r.regions ?? []);
        }
      },
      error: (e: any) => {
        this.lookupLoading.set(false);
        this.lookupError.set(e?.error?.message ?? 'Lookup failed');
      },
    });
  }

  protected canNext(): boolean {
    if (this.step() === 1) return !!this.name() && !!this.scopeId() && !this.lookupLoading();
    return true;
  }

  protected next(): void {
    if (this.canNext()) this.step.set(this.step() + 1);
  }

  protected refreshLabelFor(v: number): string {
    return this.refreshOptions.find(o => o.value === v)?.label ?? `${v} min`;
  }

  protected finalize(): void {
    this.saving.set(true);
    const spec: Partial<TopologyMapSpec> = {
      awsScopeId: this.scopeId(),
      regions: this.selectedRegions().length ? this.selectedRegions() : undefined,
      resourceTypes: this.selectedTypes().length ? this.selectedTypes() : undefined,
      refreshIntervalMinutes: this.refreshInterval(),
    };
    this.svc.create(this.name(), spec).subscribe({
      next: () => this.back(),
      error: (err: any) => {
        this.saving.set(false);
        this.formErrors()?.reportError(err);
      },
    });
  }

  protected cancel(): void { this.back(); }
  private back(): void { this.router.navigate(['..'], { relativeTo: this.route }); }
}
