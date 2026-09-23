const $ = selector => document.querySelector(selector);

let datasets = {};
let projectId = '';
let layerId = null;
let behaviorId = null;
let history = [];
let viewMode = 'flow';
let ranking = 'hybrid';
let showAll = false;

function current() { return datasets[projectId]; }
function model() { return current().behaviors; }
function layer() { return layerId ? model().layers[layerId] : null; }
function byNodeId(id) { return layer()?.nodes.find(node => node.id === id); }
function sourceText(node) {
  return (node.source_refs || []).map(ref => {
    const location = ref.location || {};
    const line = location.start_line ? `:${location.start_line}` : '';
    return `${location.path || 'source'}${line}`;
  }).join(' · ');
}

function setProject(id) {
  projectId = id;
  layerId = null;
  behaviorId = null;
  history = [];
  showAll = false;
  render();
}

function openBehavior(id) {
  const behavior = model().behaviors.find(row => row.id === id);
  if (!behavior) return;
  behaviorId = id;
  layerId = behavior.root_layer_id;
  history = [{label: current().title, layerId: null}, {label: behavior.label, layerId}];
  render();
}

function openSeed(node) {
  if (!node.child_layer_id) return;
  const earlier = history.findIndex(item => item.layerId === node.child_layer_id);
  if (earlier >= 0) {
    goHistory(earlier);
    return;
  }
  layerId = node.child_layer_id;
  history.push({label: node.label, layerId});
  render();
}

function openSourceLayer(sourceNodeId, label) {
  const target = Object.values(model().layers).find(row => row.source_node_id === sourceNodeId);
  if (!target) return;
  behaviorId = null;
  layerId = target.id;
  history = [{label: current().title, layerId: null}, {label, layerId}];
  $('#code-inventory').hidden = true;
  render();
}

function goHistory(index) {
  const item = history[index];
  history = history.slice(0, index + 1);
  layerId = item.layerId;
  if (!layerId) behaviorId = null;
  render();
}

function nodeButton(node, index) {
  const button = document.createElement('button');
  button.className = `map-node ${node.kind}`;
  button.dataset.nodeId = node.id;
  button.dataset.kind = node.kind;
  button.style.setProperty('--order', index);
  const role = document.createElement('span');
  role.className = 'node-role';
  const roleParts = [node.kind === 'seed' ? 'SEED' : node.kind.toUpperCase()];
  if (node.call_count > 1) roleParts.push(`${node.call_count} CALLS`);
  if (node.candidate_count > 1) roleParts.push(`${node.candidate_count} POSSIBLE TARGETS`);
  role.textContent = roleParts.join(' · ');
  const label = document.createElement('strong');
  label.textContent = node.label;
  button.append(role, label);
  if (node.kind === 'seed') {
    const dive = document.createElement('span');
    dive.className = 'dive';
    dive.textContent = 'Dive in  ›';
    button.append(dive);
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    showEvidence(node);
    if (node.kind === 'seed') openSeed(node);
  });
  return button;
}

function orderedNodes(active) {
  const root = active.nodes.find(node => node.id === active.root_id);
  const calls = active.nodes.filter(node => node.kind === 'node' || node.kind === 'seed');
  const byId = new Map(active.nodes.map(node => [node.id, node]));
  const order = active.leaf_orders?.[ranking] || active.leaf_ids;
  const leaves = order.map(id => byId.get(id)).filter(Boolean);
  return [root, ...calls, ...leaves].filter(Boolean);
}

function nodeDepths(active) {
  const depths = new Map([[active.root_id, 0]]);
  for (let round = 0; round < active.nodes.length; round += 1) {
    let changed = false;
    active.edges.forEach(edge => {
      if (!depths.has(edge.from)) return;
      const next = depths.get(edge.from) + 1;
      if (next > (depths.get(edge.to) ?? -1)) {
        depths.set(edge.to, next);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return depths;
}

function graphPositions(active, mode) {
  const rows = orderedNodes(active);
  const rowOrder = new Map(rows.map((node, index) => [node.id, index]));
  const depths = nodeDepths(active);
  const maxDepth = Math.max(1, ...depths.values());
  const groups = new Map();
  rows.forEach(node => {
    const depth = depths.get(node.id) ?? maxDepth;
    if (!groups.has(depth)) groups.set(depth, []);
    groups.get(depth).push(node);
  });
  const positions = new Map();
  [...groups.entries()].sort(([a], [b]) => a - b).forEach(([depth, nodes]) => {
    nodes.sort((a, b) => rowOrder.get(a.id) - rowOrder.get(b.id));
    nodes.forEach((node, index) => {
      if (mode === 'flow' && innerWidth <= 650) {
        positions.set(node.id, {
          x: nodes.length === 1 ? 50 : 16 + (68 * index) / (nodes.length - 1),
          y: 10 + (80 * depth) / maxDepth,
        });
      } else if (mode === 'flow') {
        positions.set(node.id, {
          x: 11 + (78 * depth) / maxDepth,
          y: nodes.length === 1 ? 50 : 14 + (72 * index) / (nodes.length - 1),
        });
      } else {
        const spread = 14 + (56 * depth) / maxDepth;
        const x = nodes.length === 1
          ? 50 + Math.sin(depth * 2.1) * Math.min(13, spread / 3)
          : 50 - spread / 2 + (spread * index) / (nodes.length - 1);
        positions.set(node.id, {x, y: 12 + (74 * depth) / maxDepth});
      }
    });
  });
  const maxGroup = Math.max(1, ...[...groups.values()].map(nodes => nodes.length));
  return {positions, maxDepth, maxGroup, rows};
}

function appendEdges(svg, active, positions) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.classList.add('graph-links');
  active.edges.forEach(edge => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.classList.add('graph-edge');
    line.dataset.from = edge.from;
    line.dataset.to = edge.to;
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    group.append(line);
  });
  svg.append(group);
}

function renderFlow(active) {
  const host = $('#flow-map');
  host.replaceChildren();
  host.className = 'map flow-map';
  const scene = document.createElement('div');
  scene.className = 'flow-scene';
  const {positions, maxDepth, maxGroup, rows} = graphPositions(active, 'flow');
  if (innerWidth <= 650) {
    scene.style.height = `${Math.max(540, 170 + maxDepth * 165)}px`;
    scene.style.minWidth = `${Math.max(350, maxGroup * 300)}px`;
  } else {
    scene.style.height = `${Math.max(520, maxGroup * 125)}px`;
    scene.style.minWidth = `${Math.max(900, 300 + maxDepth * 185)}px`;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('flow-links');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  appendEdges(svg, active, positions);
  scene.append(svg);
  rows.forEach((node, index) => {
    const button = nodeButton(node, index);
    const position = positions.get(node.id);
    button.style.left = `${position.x}%`;
    button.style.top = `${position.y}%`;
    scene.append(button);
  });
  host.append(scene);
}

function renderMountain(active) {
  const host = $('#flow-map');
  host.replaceChildren();
  host.className = 'map mountain-map';
  const scene = document.createElement('div');
  scene.className = 'mountain-scene';
  scene.innerHTML = `<svg class="mountain" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="mountain-light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4e4ac"/><stop offset=".45" stop-color="#a9c29c"/><stop offset="1" stop-color="#547a70"/></linearGradient></defs>
    <polygon points="50,4 96,94 4,94" fill="url(#mountain-light)"/>
    <polygon points="50,4 50,94 4,94" fill="#e0cc8f" opacity=".45"/>
    <polygon points="50,4 73,94 50,94" fill="#739589" opacity=".34"/>
  </svg>`;
  const {positions, maxGroup, rows} = graphPositions(active, 'mountain');
  scene.style.height = `${Math.max(520, maxGroup * 110)}px`;
  appendEdges(scene.querySelector('.mountain'), active, positions);
  rows.forEach((node, index) => {
    const button = nodeButton(node, index);
    const position = positions.get(node.id);
    button.style.left = `${position.x}%`;
    button.style.top = `${position.y}%`;
    scene.append(button);
  });
  host.append(scene);
}

function renderOverview() {
  $('#crumbs').replaceChildren();
  $('#view-controls').hidden = true;
  $('#overview').hidden = false;
  $('#layer-view').hidden = true;
  $('#evidence').hidden = true;
  const all = model().behaviors;
  const primary = new Set(model().primary_behavior_ids);
  const visible = showAll ? all : all.filter(row => primary.has(row.id));
  $('#overview-title').textContent = current().title;
  $('#overview-count').textContent = `${all.length} code starts found`;
  const grid = $('#behavior-grid');
  grid.replaceChildren();
  visible.forEach(behavior => {
    const card = document.createElement('button');
    card.className = 'behavior-card';
    const layer = model().layers[behavior.root_layer_id];
    const leaves = layer.leaf_orders?.[ranking] || layer.leaf_ids;
    const byId = new Map(layer.nodes.map(node => [node.id, node]));
    const ending = byId.get(leaves[0]);
    const start = document.createElement('span');
    start.className = 'behavior-start';
    start.textContent = behavior.label;
    const arrow = document.createElement('span');
    arrow.className = 'behavior-arrow';
    arrow.textContent = '→';
    const end = document.createElement('span');
    end.className = 'behavior-end';
    end.textContent = ending?.label || 'Complete';
    card.append(start, arrow, end);
    card.addEventListener('click', () => openBehavior(behavior.id));
    grid.append(card);
  });
  const more = $('#all-behaviors');
  more.hidden = all.length <= visible.length && !showAll;
  more.textContent = showAll ? 'Show primary paths' : `All paths (${all.length})`;
  $('#all-code').textContent = `All code (${model().coverage.analyzed_functions})`;
}

function renderCodeInventory(query = '') {
  const host = $('#code-list');
  host.replaceChildren();
  const unplaced = new Set(model().coverage.unplaced_function_ids);
  const rows = Object.values(model().layers).map(row => {
    const root = row.nodes.find(node => node.id === row.root_id);
    return {sourceNodeId: row.source_node_id, label: root?.label || row.source_node_id, unplaced: unplaced.has(row.source_node_id)};
  }).filter(row => row.label.toLowerCase().includes(query.toLowerCase()))
    .sort((a,b) => Number(a.unplaced)-Number(b.unplaced) || a.label.localeCompare(b.label));
  rows.forEach(row => {
    const button = document.createElement('button');
    button.className = 'code-row';
    const label = document.createElement('strong'); label.textContent = row.label;
    const meta = document.createElement('span'); meta.textContent = row.unplaced ? 'No root path · still indexed' : 'Connected to a root';
    button.append(label, meta);
    button.addEventListener('click', () => openSourceLayer(row.sourceNodeId, row.label));
    host.append(button);
  });
  $('#code-count').textContent = `${rows.length} matching functions`;
}

function renderLayer() {
  $('#overview').hidden = true;
  $('#layer-view').hidden = false;
  $('#view-controls').hidden = false;
  const active = layer();
  const crumbs = $('#crumbs');
  crumbs.replaceChildren();
  history.forEach((item, index) => {
    const button = document.createElement('button');
    button.textContent = item.label;
    button.disabled = index === history.length - 1;
    button.addEventListener('click', () => goHistory(index));
    crumbs.append(button);
    if (index < history.length - 1) crumbs.append(document.createTextNode('›'));
  });
  const currentRoot = active.nodes.find(node => node.id === active.root_id);
  $('#layer-title').textContent = currentRoot?.label || 'Focused flow';
  $('#layer-meta').textContent = `${active.nodes.filter(n => n.kind === 'seed').length} expandable · ${active.leaf_ids.length} endings`;
  if (viewMode === 'mountain') renderMountain(active); else renderFlow(active);
}

function showEvidence(node) {
  const panel = $('#evidence');
  panel.hidden = false;
  $('#evidence-role').textContent = node.kind.toUpperCase();
  $('#evidence-title').textContent = node.label;
  $('#evidence-source').textContent = sourceText(node) || 'No source location available';
  $('#evidence-id').textContent = node.source_refs?.map(ref => ref.node_id).join('\n') || node.id;
}

function render() {
  $('#project').value = projectId;
  $('#ranking').value = ranking;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === viewMode));
  if (layerId) renderLayer(); else renderOverview();
  window.__behaviorPrototype = {datasets, projectId, layerId, behaviorId, history, viewMode, ranking, model: model(), layer: layer()};
}

async function start() {
  datasets = await fetch('./behavior-fixtures.json').then(response => {
    if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
    return response.json();
  });
  const select = $('#project');
  Object.entries(datasets).forEach(([id, data]) => {
    const option = document.createElement('option');
    option.value = id; option.textContent = data.title; select.append(option);
  });
  projectId = new URLSearchParams(location.search).get('project');
  if (!datasets[projectId]) projectId = Object.keys(datasets)[0];
  select.addEventListener('change', event => setProject(event.target.value));
  $('#all-behaviors').addEventListener('click', () => { showAll = !showAll; renderOverview(); });
  $('#all-code').addEventListener('click', () => { $('#code-inventory').hidden = false; renderCodeInventory(); $('#code-search').focus(); });
  $('#close-code').addEventListener('click', () => { $('#code-inventory').hidden = true; });
  $('#code-search').addEventListener('input', event => renderCodeInventory(event.target.value));
  $('#ranking').addEventListener('change', event => { ranking = event.target.value; render(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { viewMode = button.dataset.view; render(); }));
  $('#close-evidence').addEventListener('click', () => { $('#evidence').hidden = true; });
  window.addEventListener('resize', () => { if (layerId) renderLayer(); });
  render();
}

start().catch(error => {
  $('#load-error').hidden = false;
  $('#load-error').textContent = error.message;
  throw error;
});
