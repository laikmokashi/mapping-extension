using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using System.IO.Compression;
using System.Text.Json;

namespace Duplo.Extension.Topology;

[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/topology-maps")]
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class TopologyMapsController : ResourcesController<TopologyMap, TopologyMapSpec, TopologyMapResult>
{
    private readonly TopologyMapService _svc;
    private readonly IMongoDatabase _db;

    public TopologyMapsController(IEntityService<TopologyMap> service, TopologyMapService svc, IMongoDatabase db, ILogger<TopologyMapsController> logger)
        : base(service, logger)
    {
        _svc = svc;
        _db = db;
    }

    // POST {id}/refresh — requests an immediate re-scan
    [HttpPost("{id}/refresh")]
    public async Task<IActionResult> Refresh(string workspaceId, string id, CancellationToken ct)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (entity.Status is ResourceStatus.New or ResourceStatus.Processing or ResourceStatus.Updated)
            return Conflict(new { error = "A scan is already in progress." });
        entity.Spec ??= new TopologyMapSpec();
        entity.Spec.RefreshRequestedAt = DateTime.UtcNow;
        await _svc.UpdateAsync(id, entity, ct);
        return Accepted();
    }

    // GET {id}/graph — depth-filtered, collapse-aware graph slice
    [HttpGet("{id}/graph")]
    public async Task<IActionResult> GetGraph(
        string workspaceId, string id,
        [FromQuery] string depth = "vpc",
        [FromQuery] string? expanded = null,
        [FromQuery] string? collapsed = null,
        [FromQuery] string? edgeTypes = null,
        [FromQuery] string? types = null,
        [FromQuery] string? regions = null,
        [FromQuery] string? focus = null,
        [FromQuery] int hops = 1,
        CancellationToken ct = default)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (string.IsNullOrEmpty(entity.Result?.LatestSnapshotId))
            return Ok(new GraphQueryResponse { SnapshotId = null });

        var graph = await LoadGraphAsync(entity.OwnerWorkspaceId!, entity.Result.LatestSnapshotId!, ct);
        if (graph is null) return NotFound();

        var expandedSet = expanded?.Split(',').Where(s => !string.IsNullOrEmpty(s)).ToHashSet() ?? new HashSet<string>();
        var collapsedSet = collapsed?.Split(',').Where(s => !string.IsNullOrEmpty(s)).ToHashSet() ?? new HashSet<string>();
        var edgeTypeSet = edgeTypes?.Split(',').Where(s => !string.IsNullOrEmpty(s)).ToHashSet();
        var typeSet = types?.Split(',').Where(s => !string.IsNullOrEmpty(s)).ToHashSet();
        var regionSet = regions?.Split(',').Where(s => !string.IsNullOrEmpty(s)).ToHashSet();

        var response = BuildGraphSlice(graph, depth, expandedSet, collapsedSet, edgeTypeSet, typeSet, regionSet, focus, hops);
        return Ok(response);
    }

    // GET {id}/nodes/{nodeId} — single node with SG rules
    [HttpGet("{id}/nodes/{nodeId}")]
    public async Task<IActionResult> GetNode(string workspaceId, string id, string nodeId, CancellationToken ct)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (string.IsNullOrEmpty(entity.Result?.LatestSnapshotId)) return NotFound();

        var graph = await LoadGraphAsync(entity.OwnerWorkspaceId!, entity.Result.LatestSnapshotId!, ct);
        if (graph is null) return NotFound();

        var node = graph.Nodes.FirstOrDefault(n => n.Id == Uri.UnescapeDataString(nodeId));
        if (node is null) return NotFound();

        var edges = graph.Edges.Where(e => e.Source == node.Id || e.Target == node.Id).ToList();
        return Ok(new { node, edges });
    }

    // GET {id}/nodes/{nodeId}/children — paged children
    [HttpGet("{id}/nodes/{nodeId}/children")]
    public async Task<IActionResult> GetNodeChildren(
        string workspaceId, string id, string nodeId,
        [FromQuery] string? q = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (string.IsNullOrEmpty(entity.Result?.LatestSnapshotId)) return Ok(new { items = Array.Empty<object>(), total = 0 });

        var graph = await LoadGraphAsync(entity.OwnerWorkspaceId!, entity.Result.LatestSnapshotId!, ct);
        if (graph is null) return NotFound();

        var decodedId = Uri.UnescapeDataString(nodeId);
        var children = graph.Nodes.Where(n => n.ParentId == decodedId).ToList();
        if (!string.IsNullOrEmpty(q))
            children = children.Where(n => (n.Label ?? n.Id ?? "").Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();

        var paged = children.Skip((page - 1) * pageSize).Take(pageSize).ToList();
        return Ok(new { items = paged, total = children.Count });
    }

    // GET {id}/search?q= — find node by name/label/ARN
    [HttpGet("{id}/search")]
    public async Task<IActionResult> Search(string workspaceId, string id, [FromQuery] string q = "", CancellationToken ct = default)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (string.IsNullOrEmpty(entity.Result?.LatestSnapshotId)) return Ok(Array.Empty<object>());

        var graph = await LoadGraphAsync(entity.OwnerWorkspaceId!, entity.Result.LatestSnapshotId!, ct);
        if (graph is null) return Ok(Array.Empty<object>());

        var matches = graph.Nodes
            .Where(n => (n.Label ?? "").Contains(q, StringComparison.OrdinalIgnoreCase)
                     || (n.Id ?? "").Contains(q, StringComparison.OrdinalIgnoreCase))
            .Take(20)
            .Select(n => new { n.Id, n.Type, n.Label, n.ParentId, n.Region })
            .ToList();
        return Ok(matches);
    }

    // GET {id}/inventory — server-paged flat node list
    [HttpGet("{id}/inventory")]
    public async Task<IActionResult> GetInventory(
        string workspaceId, string id,
        [FromQuery] string? q = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
    {
        var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
        if (entity is null) return NotFound();
        if (string.IsNullOrEmpty(entity.Result?.LatestSnapshotId))
            return Ok(new { items = Array.Empty<object>(), total = 0 });

        var graph = await LoadGraphAsync(entity.OwnerWorkspaceId!, entity.Result.LatestSnapshotId!, ct);
        if (graph is null) return Ok(new { items = Array.Empty<object>(), total = 0 });

        var containerTypes = new HashSet<string> { "account", "region", "vpc", "az", "subnet", "regional", "internet", "external" };
        var nodes = graph.Nodes.Where(n => !containerTypes.Contains(n.Type ?? "")).ToList();
        if (!string.IsNullOrEmpty(q))
            nodes = nodes.Where(n => (n.Label ?? "").Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();

        var items = nodes.Skip((page - 1) * pageSize).Take(pageSize)
            .Select(n => new InventoryItem
            {
                Id = n.Id,
                Type = n.Type,
                Name = n.Label,
                Region = n.Region,
                VpcId = n.Properties?.GetValueOrDefault("vpcId")?.ToString(),
                SubnetId = n.ParentId?.StartsWith("subnet:") == true ? n.ParentId : null,
            }).ToList();

        return Ok(new { items, total = nodes.Count });
    }

    // POST account-lookup — validate scope, call STS, return account info
    [HttpPost("account-lookup")]
    [AccessControl("workspaceId", Action = "topology.account-lookup", ActionName = "Lookup AWS account", Description = "Calls STS GetCallerIdentity for the supplied scope.")]
    public async Task<IActionResult> AccountLookup([FromBody] AccountLookupRequest req, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(req?.ScopeId))
            return BadRequest(new { error = "scopeId is required." });
        return Ok(await _svc.LookupAccountAsync(req.ScopeId, ct));
    }

    // ---------------------------------------------------------------------------
    // Graph slice builder
    // ---------------------------------------------------------------------------

    private static GraphQueryResponse BuildGraphSlice(
        TopologyGraph full,
        string depth,
        HashSet<string> expandedIds,
        HashSet<string> collapsedIds,
        HashSet<string>? edgeTypeFilter,
        HashSet<string>? typeFilter,
        HashSet<string>? regionFilter,
        string? focusId,
        int hops)
    {
        // Determine visible nodes based on depth + expand/collapse state
        var depthOrder = new[] { "account", "region", "vpc", "az", "subnet", "all" };
        var depthIndex = Array.IndexOf(depthOrder, depth);

        var nodeById = full.Nodes.ToDictionary(n => n.Id ?? "", n => n);
        var visibleIds = new HashSet<string>();

        foreach (var node in full.Nodes)
        {
            if (regionFilter?.Count > 0 && node.Region != null && !regionFilter.Contains(node.Region)) continue;
            if (typeFilter?.Count > 0 && node.Type != null && !typeFilter.Contains(node.Type)) continue;

            var typeDepth = node.Type switch
            {
                "account" => 0, "region" => 1, "vpc" => 2, "az" => 3, "subnet" => 4, _ => 5
            };

            var collapsed = collapsedIds.Contains(node.Id ?? "");
            var parentCollapsed = IsAncestorCollapsed(node, nodeById, collapsedIds);
            if (parentCollapsed) continue;

            if (depthIndex >= 5 || typeDepth <= depthIndex || expandedIds.Contains(node.Id ?? ""))
                visibleIds.Add(node.Id ?? "");
        }

        // Focus: keep only nodes within N hops of focusId
        if (!string.IsNullOrEmpty(focusId))
        {
            var adjacency = BuildAdjacency(full.Edges);
            var inFocus = BfsHops(focusId, hops, adjacency);
            visibleIds.IntersectWith(inFocus);
            visibleIds.Add(focusId);
        }

        var resultNodes = full.Nodes
            .Where(n => visibleIds.Contains(n.Id ?? ""))
            .ToList();

        // Lift edges to nearest visible ancestor + merge duplicates
        var resultEdges = new List<TopologyEdge>();
        var edgeCounts = new Dictionary<string, int>();
        foreach (var edge in full.Edges)
        {
            if (edgeTypeFilter?.Count > 0 && !edgeTypeFilter.Contains(edge.Type ?? "")) continue;
            var src = NearestVisibleAncestor(edge.Source, visibleIds, nodeById);
            var tgt = NearestVisibleAncestor(edge.Target, visibleIds, nodeById);
            if (src == null || tgt == null || src == tgt) continue;
            var key = $"{edge.Type}:{src}->{tgt}";
            edgeCounts[key] = (edgeCounts.TryGetValue(key, out var c) ? c : 0) + 1;
        }
        foreach (var (key, count) in edgeCounts)
        {
            var parts = key.Split(':');
            var edgeType = parts[0];
            var rest = string.Join(":", parts.Skip(1)).Split("->");
            resultEdges.Add(new TopologyEdge { Id = key, Type = edgeType, Source = rest[0], Target = rest.Length > 1 ? rest[1] : rest[0], Count = count });
        }

        // Annotate collapsed container nodes with child counts
        foreach (var node in resultNodes)
        {
            if (collapsedIds.Contains(node.Id ?? "") || (node.Type != "vpc" && node.Type != "region" && node.Type != "subnet" && node.Type != "az"))
                continue;
            var children = full.Nodes.Where(n => n.ParentId == node.Id).ToList();
            if (children.Count > 0 && !expandedIds.Contains(node.Id ?? ""))
            {
                node.ChildCount = children.Count;
                node.ChildCountsByType = children.GroupBy(c => c.Type ?? "unknown").ToDictionary(g => g.Key, g => g.Count());
            }
        }

        var truncated = resultNodes.Count > 1500 || resultEdges.Count > 3000;
        return new GraphQueryResponse
        {
            SnapshotId = full.SnapshotId,
            Nodes = resultNodes.Take(1500).ToList(),
            Edges = resultEdges.Take(3000).ToList(),
            Truncated = truncated,
        };
    }

    private static bool IsAncestorCollapsed(TopologyNode node, Dictionary<string, TopologyNode> byId, HashSet<string> collapsed)
    {
        var parentId = node.ParentId;
        while (parentId != null)
        {
            if (collapsed.Contains(parentId)) return true;
            parentId = byId.TryGetValue(parentId, out var p) ? p.ParentId : null;
        }
        return false;
    }

    private static Dictionary<string, HashSet<string>> BuildAdjacency(List<TopologyEdge> edges)
    {
        var adj = new Dictionary<string, HashSet<string>>();
        foreach (var e in edges)
        {
            if (!adj.ContainsKey(e.Source ?? "")) adj[e.Source!] = new();
            if (!adj.ContainsKey(e.Target ?? "")) adj[e.Target!] = new();
            adj[e.Source!].Add(e.Target!);
            adj[e.Target!].Add(e.Source!);
        }
        return adj;
    }

    private static HashSet<string> BfsHops(string start, int hops, Dictionary<string, HashSet<string>> adj)
    {
        var visited = new HashSet<string> { start };
        var frontier = new HashSet<string> { start };
        for (int i = 0; i < hops; i++)
        {
            var next = new HashSet<string>();
            foreach (var n in frontier)
                if (adj.TryGetValue(n, out var neighbors))
                    foreach (var nb in neighbors)
                        if (visited.Add(nb)) next.Add(nb);
            if (next.Count == 0) break;
            frontier = next;
        }
        return visited;
    }

    private static string? NearestVisibleAncestor(string? nodeId, HashSet<string> visible, Dictionary<string, TopologyNode> byId)
    {
        var current = nodeId;
        while (current != null)
        {
            if (visible.Contains(current)) return current;
            current = byId.TryGetValue(current, out var n) ? n.ParentId : null;
        }
        return null;
    }

    // ---------------------------------------------------------------------------
    // Graph cache loader
    // ---------------------------------------------------------------------------

    private async Task<TopologyGraph?> LoadGraphAsync(string workspaceId, string snapshotId, CancellationToken ct)
    {
        lock (TopologyMapWorker.CacheLock)
        {
            // Check if snapshot is cached by snapshotId (any map)
            foreach (var kv in TopologyMapWorker.GraphCache.Values)
                if (kv.SnapshotId == snapshotId) return kv.Graph;
        }

        var coll = _db.GetCollection<TopologyMapSnapshot>("extension_topologymap_snapshot");
        var snap = await coll.Find(Builders<TopologyMapSnapshot>.Filter.Eq(s => s.Id, snapshotId)).FirstOrDefaultAsync(ct);
        if (snap?.GraphGzip == null) return null;

        using var ms = new MemoryStream(snap.GraphGzip);
        using var gz = new GZipStream(ms, CompressionMode.Decompress);
        using var sr = new System.IO.StreamReader(gz);
        var json = await sr.ReadToEndAsync(ct);
        var graph = JsonSerializer.Deserialize<TopologyGraph>(json);
        if (graph != null) graph.SnapshotId = snapshotId;
        return graph;
    }
}
