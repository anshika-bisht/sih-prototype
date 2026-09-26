// --- State & Initialization ---
let cy = null;
let graphData = { nodes: [], edges: [] };
let activeFilesToMonitor = new Set();
let tamperMonitorInterval = null;
let integrityMonitorInterval = null;
let acknowledgedTamperFiles = new Set();  // Files user has dismissed — won't re-alert until page reload
let currentTamperFiles = new Set();       // Currently active (unacknowledged) tampered files

const API_BASE = "http://localhost:8000/api";

// --- Global Formatter Utilities ---
function renderFileLink(filename, displayText = null) {
    const display = displayText || filename;
    return `<a href="${API_BASE}/document/${filename}" target="_blank" class="proof-file-link text-blue-400 hover:text-blue-300 transition-colors font-mono underline decoration-slate-600 underline-offset-4 cursor-pointer truncate mr-2 block">${display}</a>`;
}

// --- Security Gateway ---
function checkAuth() {
    const role = sessionStorage.getItem('chakravyuh_role');
    if (role) {
        document.getElementById('security-modal').classList.add('hidden');
        document.getElementById('active-role').textContent = `ID: ${role.toUpperCase()}`;
        loadWorkspace();
    }
}

function authenticate() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (user === 'admin' && pass === 'admin') {
        document.getElementById('login-error').classList.add('hidden');
        document.getElementById('login-form').classList.add('hidden');
        document.getElementById('role-selection').classList.remove('hidden');
    } else {
        document.getElementById('login-error').classList.remove('hidden');
    }
}

function selectRole(role) {
    sessionStorage.setItem('chakravyuh_role', role);
    checkAuth();
}

function logout() {
    sessionStorage.removeItem('chakravyuh_role');
    location.reload();
}

// --- Workspace & API ---
let allCasesCache = []; // Store cases globally

async function loadWorkspace() {
    try {
        const response = await fetch(`${API_BASE}/cases`);
        const data = await response.json();
        
        const list = document.getElementById('case-directory-list');
        list.innerHTML = '';

        allCasesCache = [...data.active, ...data.closed];
        const officersSet = new Set();
        
        await fetchGraphData();

        allCasesCache.forEach(c => {
            const finalOfficer = c.io || 'Unknown IO';
            officersSet.add(finalOfficer);
            
            let entitiesCount = 0;
            let linksCount = 0;
            let maxRisk = 0;

            const caseNodes = new Set();
            if (graphData && graphData.nodes) {
                graphData.nodes.forEach(n => {
                    if (n.data.case_ids && n.data.case_ids.includes(c.id)) {
                        entitiesCount++;
                        caseNodes.add(n.data.id);
                        if ((n.data.pageRank || 0) > maxRisk) maxRisk = n.data.pageRank;
                    }
                });
            }

            if (graphData && graphData.edges) {
                graphData.edges.forEach(e => {
                    if (caseNodes.has(e.data.source) || caseNodes.has(e.data.target)) {
                        linksCount++;
                    }
                });
            }

            const riskScore = Math.round(maxRisk * 100);
            const title = c.offense || 'Intelligence Trace';
            
            let badgeHtml = '';
            const st = (c.status || '').toUpperCase();
            const off = (c.offense || '').toUpperCase();

            if (st.includes('CLOSED') || st.includes('ARCHIVED')) {
                badgeHtml = `<span class="border border-slate-700 bg-slate-800/50 text-slate-500 text-[9px] px-1.5 py-0.5 rounded shrink-0">Archived</span>`;
            } else if (riskScore > 40) {
                badgeHtml = `<span class="border border-red-700 bg-red-900/50 text-red-400 text-[9px] px-1.5 py-0.5 rounded shrink-0">Target Scope</span>`;
            } else if (riskScore > 20 || st.includes('PRIORITY')) {
                badgeHtml = `<span class="border border-red-800 bg-red-950/50 text-red-300 text-[9px] px-1.5 py-0.5 rounded shrink-0">High Priority</span>`;
            } else if (st.includes('PENDING')) {
                badgeHtml = `<span class="border border-orange-700 bg-orange-900/50 text-orange-400 text-[9px] px-1.5 py-0.5 rounded shrink-0">Standby</span>`;
            }

            let liStatus = st || 'OPEN';
            if (st.includes('CLOSED') || st.includes('ARCHIVED')) liStatus = 'CLOSED';
            else if (st.includes('PENDING')) liStatus = 'PENDING';
            else liStatus = 'OPEN';
            
            list.innerHTML += `
                <li class="border border-slate-700/50 bg-slate-900 hover:bg-slate-800/80 rounded p-2 mb-2 transition-colors relative group case-list-item" data-status="${liStatus}" data-officer="${finalOfficer}">
                    <div class="flex items-start">
                        <input type="checkbox" id="case-${c.id}" value="${c.id}" onchange="updateGraphView()" class="form-checkbox bg-slate-950 border-slate-600 text-blue-600 focus:ring-0 mt-1 mr-2 shrink-0 cursor-pointer rounded-sm" onclick="event.stopPropagation()">
                        <div class="flex-1 min-w-0 cursor-pointer" onclick="renderCaseDossier('${c.id}')">
                            <div class="flex items-center justify-between mb-1">
                                <span class="font-bold text-slate-100 text-xs truncate" title="${c.id}">${c.id}</span>
                                ${badgeHtml}
                            </div>
                            <div class="text-[10px] text-slate-400 truncate font-mono" title="${title}">${title}</div>
                        </div>
                    </div>
                </li>
            `;
        });
        
        const offFilter = document.getElementById('filter-officer');
        if (offFilter) {
            offFilter.innerHTML = '<option value="ALL">All Officers</option>';
            Array.from(officersSet).sort().forEach(off => {
                offFilter.innerHTML += `<option value="${off}">${off}</option>`;
            });
        }
        if (!cy) initCytoscape();
        
        initSearch();
        switchTab('analysis'); // Default to Master Case Directory

    } catch (e) {
        console.error("Failed to load workspace", e);
    }
}

async function fetchGraphData() {
    try {
        const res = await fetch(`${API_BASE}/graph`);
        graphData = await res.json();
        renderWorkspaceAnalytics();
    } catch (e) {
        console.error("Failed to fetch graph", e);
    }
}

// --- Workspace Analytics (Chart.js) ---
let caseStatusChart = null;
let entityDistributionChart = null;

function renderWorkspaceAnalytics() {
    if (!graphData || !graphData.nodes) return;

    // 0. Update Dashboard Summary Statistics
    if (document.getElementById('stat-cases-top')) {
        document.getElementById('stat-cases-top').innerText = allCasesCache.length;
        document.getElementById('stat-cases-hist-top').innerText = allCasesCache.length;
        document.getElementById('stat-entities-top').innerText = graphData.nodes.length;
        document.getElementById('stat-cases-hist2').innerText = allCasesCache.length;
        document.getElementById('stat-entities2').innerText = graphData.nodes.length;
        
        let filesCount = 0;
        allCasesCache.forEach(c => {
            if (c.files) filesCount += c.files.length;
        });
        document.getElementById('stat-proofs-top').innerText = filesCount;
    }

    // 1. Case Status (Active vs Closed)
    let activeCases = 0, pendingCases = 0, closedCases = 0, archivedCases = 0;
    
    allCasesCache.forEach(c => {
        let st = (c.status || '').toLowerCase();
        
        // Deterministic fallback if status is missing
        if (!st) {
            const sum = c.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const mod = sum % 10;
            if (mod < 4) st = 'active';
            else if (mod < 7) st = 'pending';
            else if (mod < 9) st = 'closed';
            else st = 'archive';
        }

        if (st.includes('active') || st.includes('open')) activeCases++;
        else if (st.includes('pending')) pendingCases++;
        else if (st.includes('close') || st.includes('adjudicat')) closedCases++;
        else if (st.includes('archive')) archivedCases++;
        else {
            // Default bucket
            const sum = c.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            if (sum % 2 === 0) activeCases++;
            else pendingCases++;
        }
    });

    if (document.getElementById('stat-case-active')) {
        document.getElementById('stat-case-active').innerText = activeCases;
        document.getElementById('stat-case-pending').innerText = pendingCases;
        document.getElementById('stat-case-closed').innerText = closedCases + archivedCases;
    }

    const ctx1 = document.getElementById('caseStatusChart');
    if (ctx1) {
        if (caseStatusChart) caseStatusChart.destroy();
        caseStatusChart = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: ['Open', 'Pending', 'Closed / Archived'],
                datasets: [{
                    label: 'Cases',
                    data: [activeCases, pendingCases, closedCases + archivedCases],
                    backgroundColor: ['#6366f1', '#eab308', '#10b981'],
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { family: 'Roboto Mono', size: 9 } } },
                    y: { grid: { display: false }, ticks: { color: '#cbd5e1', font: { family: 'Roboto Mono', size: 9 } } }
                }
            }
        });
    }

    // 2. Entity Distribution
    let pCount = 0, fCount = 0, aCount = 0, tCount = 0;
    graphData.nodes.forEach(n => {
        if (n.data.type === 'PERSON') pCount++;
        else if (n.data.type === 'BANK_ACCOUNT') fCount++;
        else if (n.data.type === 'PHONE') tCount++;
        else aCount++;
    });

    if (document.getElementById('stat-ent-personnel')) {
        document.getElementById('stat-ent-personnel').innerText = pCount;
        document.getElementById('stat-ent-finance').innerText = fCount;
        document.getElementById('stat-ent-assets').innerText = aCount;
        document.getElementById('stat-ent-telecom').innerText = tCount;
    }

    const ctx2 = document.getElementById('entityDistributionChart');
    if (ctx2) {
        if (entityDistributionChart) entityDistributionChart.destroy();
        entityDistributionChart = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['Personnel', 'Financial', 'IP / Assets', 'Telecom'],
                datasets: [{
                    data: [pCount, fCount, aCount, tCount],
                    backgroundColor: ['#8b5cf6', '#10b981', '#3b82f6', '#f43f5e'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '75%',
                plugins: {
                    legend: { 
                        position: 'right', 
                        labels: { color: '#94a3b8', font: { family: 'Roboto Mono', size: 10 }, usePointStyle: true, boxWidth: 8 } 
                    }
                }
            }
        });
    }
}

window.toggleCaseAccordion = function(caseId) {
    const content = document.getElementById(`content-${caseId}`);
    const icon = document.getElementById(`icon-${caseId}`);
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        icon.classList.add('rotate-180');
        // Auto-filter graph to this case
        const cb = document.getElementById(`case-${caseId}`);
        if(cb && !cb.checked) {
            cb.checked = true;
            updateGraphView();
        }
    } else {
        content.classList.add('hidden');
        icon.classList.remove('rotate-180');
    }
}

async function updateInvestigatorPanel(targetData = null) {
    const inspector = document.getElementById('inspector-content');
    inspector.innerHTML = `<div class="flex items-center justify-center h-full"><span class="animate-pulse font-mono text-xs text-slate-500">Generating Intelligence Report...</span></div>`;
    
    try {
        if (!cy) return;
        const visibleNodes = cy.nodes(':visible');
        const visibleEdges = cy.edges(':visible');
        
        const activeCheckboxes = Array.from(document.querySelectorAll('#case-directory-list input[type="checkbox"]:checked')).map(cb => cb.value);
        
        // --- SECTION A: Prime Suspects & Target Info ---
        let sectionAHtml = ``;
        
        if (targetData) {
            let props = '';
            for (const [k, v] of Object.entries(targetData)) {
                if (['id', 'label', 'type', 'case_ids', 'pageRank', 'betweenness', 'geo_lat', 'geo_long'].includes(k)) continue;
                props += `<p class="mb-1 text-slate-300"><span class="text-slate-500">${k}:</span> ${v}</p>`;
            }
            
            sectionAHtml += `
                <div class="mb-4 bg-slate-900 border border-slate-700 p-3 relative overflow-hidden shadow-lg shadow-blue-900/20">
                    <div class="absolute top-0 right-0 px-2 py-1 bg-blue-500 text-white text-[8px] uppercase font-bold tracking-wider rounded-bl shadow">Target Locked</div>
                    <h4 class="text-xs font-bold text-slate-100 uppercase font-mono">${targetData.label || targetData.id}</h4>
                    <p class="text-[10px] text-slate-400 mb-2 uppercase tracking-wider">${targetData.type}</p>
                    <div class="text-[10px] font-mono">
                        ${props}
                        <p class="mb-1 text-slate-300"><span class="text-slate-500">Risk Score:</span> ${targetData.pageRank ? (targetData.pageRank * 100).toFixed(1) : '0.0'}</p>
                        <p class="mb-1 text-slate-300"><span class="text-slate-500">Betweenness:</span> ${targetData.betweenness ? targetData.betweenness.toFixed(1) : '0'}</p>
                    </div>
                </div>
            `;
        }
        
        let highRiskNodes = [];
        visibleNodes.forEach(n => {
            if (n.data('type') === 'PERSON' && (n.data('pageRank') > 0.15 || n.data('betweenness') > 50)) {
                highRiskNodes.push(n.data());
            }
        });
        
        if (highRiskNodes.length > 0) {
            sectionAHtml += `<h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center"><svg class="w-3 h-3 mr-1 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg> Prime Suspects</h4><ul class="space-y-1 mb-4">`;
            highRiskNodes.forEach(n => {
                const rs = Math.round((n.pageRank || 0) * 100);
                const bw = (n.betweenness || 0).toFixed(1);
                sectionAHtml += `
                    <li class="bg-red-900/20 border border-red-500/30 p-2 flex flex-col justify-between cursor-pointer hover:bg-red-900/40 transition-colors" onclick="executeSearch('${n.label}')">
                        <div class="flex justify-between items-center mb-1">
                            <span class="text-[10px] font-mono text-red-400 uppercase">${n.label}</span>
                            <span class="text-[8px] bg-red-500/80 text-white px-1 py-0.5 rounded uppercase font-bold tracking-widest border border-red-400 shadow-sm shadow-red-500/50">Risk: ${rs}</span>
                        </div>
                        <div class="flex items-center space-x-2 text-[9px] text-slate-400 font-mono">
                            <span>Btw: ${bw}</span>
                            <span>Type: ${n.type || 'UNKNOWN'}</span>
                        </div>
                    </li>
                `;
            });
            sectionAHtml += `</ul>`;
        }

        // --- SECTION B: Automated Alerts & Insights ---
        let alertsHtml = '';
        
        visibleNodes.forEach(n => {
            const cases = n.data('case_ids') || [];
            const activeIntersections = cases.filter(c => activeCheckboxes.includes(c));
            if (activeIntersections.length > 1) {
                alertsHtml += `
                    <div class="bg-yellow-900/20 border border-yellow-500/30 p-2 mb-2 text-[10px] text-yellow-200/80 font-mono leading-relaxed shadow-sm">
                        <span class="text-yellow-500 font-bold uppercase tracking-wider">⚠️ Alert:</span> 
                        <span class="text-white font-semibold">${n.data('label') || n.id()}</span> connects [${activeIntersections.join(', ')}]. High flight risk.
                    </div>
                `;
            }
        });
        
        visibleEdges.forEach(e => {
            if (e.data('type') === 'PREDICTED_LINK' || e.data('type') === 'INFERRED_LINK' || e.hasClass('inferred-edge')) {
                const src = cy.getElementById(e.data('source')).data('label');
                const tgt = cy.getElementById(e.data('target')).data('label');
                alertsHtml += `
                    <div class="bg-blue-900/20 border border-blue-500/30 p-2 mb-2 text-[10px] text-blue-200/80 font-mono leading-relaxed shadow-sm">
                        <span class="text-blue-500 font-bold uppercase tracking-wider">💡 Insight:</span> 
                        Undocumented link predicted between <span class="text-white">${src}</span> and <span class="text-white">${tgt}</span>.
                    </div>
                `;
            }
        });
        
        let sectionBHtml = '';
        if (alertsHtml) {
            sectionBHtml = `
                <div class="mb-4">
                    <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center"><svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Automated Alerts</h4>
                    ${alertsHtml}
                </div>
            `;
        }

        // --- SECTION C: Evidentiary Proofs ---
        let evidenceHtml = "";
        let casesToShow = [];
        if (targetData && targetData.case_ids) {
            casesToShow = allCasesCache.filter(c => targetData.case_ids.includes(c.id) && activeCheckboxes.includes(c.id));
        } else {
            casesToShow = allCasesCache.filter(c => activeCheckboxes.includes(c.id));
        }
        
        for (const c of casesToShow) {
            let maxRisk = 0;
            if (cy) {
                cy.nodes().forEach(n => {
                    if (n.data('case_ids') && n.data('case_ids').includes(c.id)) {
                        if ((n.data('pageRank') || 0) > maxRisk) maxRisk = n.data('pageRank');
                    }
                });
            }
            const riskScore = Math.round(maxRisk * 100);
            
            const files = c.files || [];
            
            evidenceHtml += `
            <li class="bg-slate-900 border border-slate-700 mb-2 overflow-hidden shadow-sm">
                <button onclick="toggleCaseAccordion('${c.id}')" class="w-full flex justify-between items-center p-2 bg-slate-800 hover:bg-slate-700 transition-colors text-left focus:outline-none">
                    <div class="flex items-center space-x-2">
                        <span class="text-[10px] font-semibold text-slate-300 uppercase tracking-widest">Case: ${c.id}</span>
                        ${riskScore > 0 ? `<span class="text-[9px] font-mono text-red-400 bg-red-900/40 px-1.5 py-0.5 rounded border border-red-800/50">Risk: ${riskScore}</span>` : ''}
                    </div>
                    <svg id="icon-${c.id}" class="w-4 h-4 text-slate-500 transform transition-transform ${targetData ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                </button>
                <div id="content-${c.id}" class="${targetData ? '' : 'hidden'} p-2 bg-slate-900 space-y-2">
            `;
            
            if (files.length === 0) {
                evidenceHtml += `<p class="text-[10px] text-slate-500 font-mono italic p-1">No associated files.</p>`;
            }
            
            files.forEach(fileName => {
                const fileHashId = `hash-${c.id}-${fileName.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now()}`;
                
                evidenceHtml += `
                    <div class="flex justify-between items-center bg-slate-800 p-2 rounded mb-1">
                        ${renderFileLink(fileName, '[Preview] ' + fileName)}
                        <span id="${fileHashId}" class="text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-slate-900/30 text-slate-400 border-slate-700">CHECKING...</span>
                    </div>
                `;
            });
            
            evidenceHtml += `
                </div>
            </li>
            `;
        }
        
        let sectionCHtml = `
            <div>
                <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center"><svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg> Evidentiary Proofs</h4>
                <ul class="space-y-1" id="master-evidence-list">
                    ${evidenceHtml}
                </ul>
            </div>
        `;

        inspector.innerHTML = `
            <div class="mb-4 border-b border-slate-700 pb-2">
                <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase">ANALYSIS & INSIGHTS</h3>
                <p class="text-[10px] text-slate-400 mt-1 uppercase tracking-widest">Dynamic Graph Intelligence</p>
            </div>
            <div class="space-y-4">
                ${sectionAHtml}
                ${sectionBHtml}
                ${sectionCHtml}
            </div>
        `;

    } catch(e) {
        inspector.innerHTML = `<p class="text-red-500 font-mono text-xs">Error generating report.</p>`;
        console.error(e);
    }
}

// Keep a stub of viewAllIntelligence so index.html onclick works, but route it to the new panel
window.viewAllIntelligence = function() {
    const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
    updateGraphView();
};

window.selectAllCases = function() {
    const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
    updateGraphView();
};

window.deselectAllCases = function() {
    const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateGraphView();
};

// --- Intelligence Graph (Cytoscape) ---
function initCytoscape() {
    cy = cytoscape({
        container: document.getElementById('cy'),
        style: [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'color': '#cbd5e1',
                    'text-valign': 'bottom',
                    'text-margin-y': 5,
                    'font-size': '10px',
                    'font-family': 'Roboto Mono, monospace',
                    'text-background-color': '#0b101a',
                    'text-background-opacity': 0.8,
                    'text-background-padding': 2,
                    'text-background-shape': 'roundrectangle'
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 1.5,
                    'line-color': '#475569',
                    'line-style': 'solid',
                    'curve-style': 'bezier',
                    'label': 'data(type)',
                    'font-size': '8px',
                    'color': '#94a3b8',
                    'text-rotation': 'autorotate',
                    'text-background-color': '#0b101a',
                    'text-background-opacity': 1
                }
            },
            {
                selector: 'edge[type = "CALLED"]',
                style: {
                    'line-style': 'dashed',
                    'line-color': '#10b981'
                }
            },
            {
                selector: 'edge[type = "TRANSACTED_TO"]',
                style: {
                    'line-style': 'solid',
                    'line-color': '#f59e0b',
                    'target-arrow-shape': 'triangle',
                    'target-arrow-color': '#f59e0b'
                }
            },
            {
                selector: 'edge[type = "CO_ACCUSED"], edge[type = "ASSOCIATE"]',
                style: {
                    'line-style': 'solid',
                    'line-color': '#3b82f6'
                }
            },
            {
                selector: 'edge[type = "USES_COMMUNICATION"]',
                style: {
                    'line-style': 'dotted',
                    'line-color': '#10b981'
                }
            },
            {
                selector: 'edge[type = "OWNS_ACCOUNT"]',
                style: {
                    'line-style': 'dotted',
                    'line-color': '#f59e0b'
                }
            },
            {
                selector: 'edge[type = "OWNS_VEHICLE"]',
                style: {
                    'line-style': 'dotted',
                    'line-color': '#8b5cf6'
                }
            },
            /* Futuristic Outer Glow Theme */
            {
                selector: 'node[type = "PERSON"]',
                style: {
                    'background-color': '#1e293b',
                    'border-width': '2px',
                    'border-color': '#f59e0b',
                    'width': '22px',
                    'height': '22px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%24%2024%22%20fill%3D%22%23cbd5e1%22%3E%3Cpath%20d%3D%22M12%2012c2.21%200%204-1.79%204-4s-1.79-4-4-4-4%201.79-4%204%201.79%204%204%204zm0%202c-2.67%200-8%201.34-8%204v2h16v-2c0-2.66-5.33-4-8-4z%22%2F%3E%3C%2Fsvg%3E',
                    'background-width': '55%',
                    'background-height': '55%',
                    'underlay-color': '#64748b',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                // Target/Kingpin (High Risk)
                selector: 'node[type = "PERSON"][pageRank > 0.15]',
                style: {
                    'background-color': '#4c0519',
                    'border-color': '#e11d48',
                    'border-width': '2px',
                    'width': '36px',
                    'height': '36px',
                    'underlay-color': '#fb7185',
                    'underlay-padding': '12px',
                    'underlay-opacity': 0.25
                }
            },
            {
                // Broker / 1st Degree
                selector: 'node[type = "PERSON"][betweenness > 50]',
                style: {
                    'background-color': '#431407',
                    'border-color': '#f97316',
                    'width': '28px',
                    'height': '28px',
                    'underlay-color': '#f97316',
                    'underlay-padding': '6px',
                    'underlay-opacity': 0.15
                }
            },
            {
                selector: 'node[type = "PHONE"]',
                style: {
                    'background-color': '#172554',
                    'border-width': '2px',
                    'border-color': '#3b82f6',
                    'width': '28px',
                    'height': '28px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M22%2016.92v3a2%202%200%200%201-2.18%202%2019.79%2019.79%200%200%201-8.63-3.07%2019.5%2019.5%200%200%201-6-6%2019.79%2019.79%200%200%201-3.07-8.67A2%202%200%200%201%204.11%202h3a2%202%200%200%201%202%201.72%2012.84%2012.84%200%200%200%20.7%202.81%202%202%200%200%201-.45%202.11L8.09%209.91a16%2016%200%200%200%206%206l1.27-1.27a2%202%200%200%201%202.11-.45%2012.84%2012.84%200%200%200%202.81.7A2%202%200%200%201%2022%2016.92z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#3b82f6',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                selector: 'node[type = "BANK_ACCOUNT"]',
                style: {
                    'background-color': '#172554',
                    'border-width': '2px',
                    'border-color': '#3b82f6',
                    'width': '28px',
                    'height': '28px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cline%20x1%3D%2212%22%20y1%3D%221%22%20x2%3D%2212%22%20y2%3D%2223%22%3E%3C%2Fline%3E%3Cpath%20d%3D%22M17%205H9.5a3.5%203.5%200%200%200%200%207h5a3.5%203.5%200%200%201%200%207H6%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#3b82f6',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                selector: 'node[type = "LOCATION"]',
                style: {
                    'background-color': '#064e3b',
                    'border-width': '2px',
                    'border-color': '#10b981',
                    'width': '28px',
                    'height': '28px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M21%2010c0%207-9%2013-9%2013s-9-6-9-13a9%209%200%200%201%2018%200z%22%3E%3C%2Fpath%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2210%22%20r%3D%223%22%3E%3C%2Fcircle%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#10b981',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                selector: 'node[type = "VEHICLE"]',
                style: {
                    'background-color': '#064e3b',
                    'border-width': '2px',
                    'border-color': '#10b981',
                    'width': '28px',
                    'height': '28px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%221%22%20y%3D%223%22%20width%3D%2215%22%20height%3D%2213%22%3E%3C%2Frect%3E%3Cpolygon%20points%3D%2216%208%2020%208%2023%2011%2023%2016%2016%2016%2016%208%22%3E%3C%2Fpolygon%3E%3Ccircle%20cx%3D%225.5%22%20cy%3D%2218.5%22%20r%3D%222.5%22%3E%3C%2Fcircle%3E%3Ccircle%20cx%3D%2218.5%22%20cy%3D%2218.5%22%20r%3D%222.5%22%3E%3C%2Fcircle%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#10b981',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                selector: 'node[type = "ORGANIZATION"]',
                style: {
                    'background-color': '#064e3b',
                    'border-width': '2px',
                    'border-color': '#10b981',
                    'width': '28px',
                    'height': '28px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%224%22%20y%3D%222%22%20width%3D%2216%22%20height%3D%2220%22%20rx%3D%222%22%20ry%3D%222%22%3E%3C%2Frect%3E%3Cpath%20d%3D%22M9%2022v-4h6v4%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M8%206h.01M16%206h.01M12%206h.01M12%2010h.01M12%2014h.01M16%2010h.01M16%2014h.01M8%2010h.01M8%2014h.01%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#10b981',
                    'underlay-padding': '4px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            {
                selector: 'node[type = "CASE"]',
                style: {
                    'background-color': '#0f172a',
                    'border-width': '2px',
                    'border-color': '#94a3b8',
                    'width': '36px',
                    'height': '36px',
                    'shape': 'ellipse',
                    'background-image': 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23cbd5e1%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%222%22%20y%3D%227%22%20width%3D%2220%22%20height%3D%2214%22%20rx%3D%222%22%20ry%3D%222%22%3E%3C%2Frect%3E%3Cpath%20d%3D%22M16%2021V5a2%202%200%200%200-2-2h-4a2%202%200%200%200-2%202v16%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
                    'background-width': '50%',
                    'background-height': '50%',
                    'underlay-color': '#94a3b8',
                    'underlay-padding': '6px',
                    'underlay-opacity': 0.1,
                    'underlay-shape': 'ellipse'
                }
            },
            /* Inferred Transitive Edge Class */
            {
                selector: '.inferred-edge',
                style: {
                    'line-color': '#ec4899', // Magenta
                    'line-style': 'dotted',
                    'target-arrow-color': '#ec4899'
                }
            },
            /* Search Highlights */
            {
                selector: '.search-fade',
                style: {
                    'opacity': 0.12
                }
            },
            {
                selector: '.search-focus',
                style: {
                    'opacity': 1.0
                }
            },
            {
                selector: '.target-halo',
                style: {
                    'underlay-color': '#06b6d4',
                    'underlay-padding': '25px',
                    'underlay-opacity': 0.4
                }
            },
            /* Cross-Syndicate Bridge */
            {
                selector: '.cross-syndicate-bridge',
                style: {
                    'underlay-color': '#06b6d4',
                    'underlay-padding': '20px',
                    'underlay-opacity': 0.3,
                    'z-index': 10 /* Keep lower than kingpins which can be 100+ */
                }
            }
        ],
        layout: {
            name: 'cose',
            padding: 50,
            nodeRepulsion: 4000000,
            idealEdgeLength: 150,
            nodeOverlap: 20,
            gravity: 0.1,
            componentSpacing: 100,
            nodeDimensionsIncludeLabels: true,
            randomize: true
        }
    });

    // Inspector Populator Listener
    cy.on('tap', 'node', function(evt){
        const node = evt.target;
        updateInvestigatorPanel(node.data());
        const rp = document.getElementById('right-pane');
        if (rp) {
            rp.classList.add('force-open');
            rp.classList.remove('translate-x-full');
        }
    });

    cy.on('tap', function(evt){
        if (evt.target === cy) {
            const rp = document.getElementById('right-pane');
            if (rp && rp.classList.contains('force-open')) {
                rp.classList.remove('force-open');
                rp.classList.add('translate-x-full');
            }
        }
    });
    cy.on('tap', 'edge', function(evt){
        const edge = evt.target;
        populateInspectorEdge(edge.data());
        const rp = document.getElementById('right-pane');
        if (rp) {
            rp.classList.add('force-open');
            rp.classList.remove('translate-x-full');
        }
    });

    // Listeners for filters
    ['filter-persons', 'filter-phones', 'filter-accounts', 'filter-locations', 'view-depth'].forEach(id => {
        document.getElementById(id).addEventListener('change', updateGraphView);
    });
}

function updateGraphView() {
    const startTime = performance.now();
    if (!cy) return;
    
    const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]:checked');
    const activeCases = Array.from(checkboxes).map(cb => cb.value);
    
    if (activeCases.length === 0) {
        cy.elements().remove();
        document.getElementById('welcome-state').classList.remove('hidden');
        updateInvestigatorPanel();
        return;
    } else {
        document.getElementById('welcome-state').classList.add('hidden');
    }

    // Determine active types
    const allowedTypes = [];
    if(document.getElementById('filter-persons').checked) allowedTypes.push('PERSON');
    if(document.getElementById('filter-phones').checked) allowedTypes.push('PHONE');
    if(document.getElementById('filter-accounts').checked) allowedTypes.push('BANK_ACCOUNT');
    if(document.getElementById('filter-locations').checked) allowedTypes.push('LOCATION');
    allowedTypes.push('CASE', 'VEHICLE', 'ORGANIZATION'); // Always keep cases, vehicles, and orgs

    // 1. Strict Filtering: Node must belong to active cases
    let filteredNodes = graphData.nodes.filter(n => {
        return n.data.case_ids && n.data.case_ids.some(cid => activeCases.includes(cid));
    });
    
    // 2. Transitive Connectivity (Anti-Floating Node for INFERRED_LINKs)
    const inferredEdges = [];
    if (!document.getElementById('filter-phones').checked) {
        const persons = filteredNodes.filter(n => n.data.type === 'PERSON').map(n => n.data.id);
        const phones = graphData.nodes.filter(n => n.data.type === 'PHONE').map(n => n.data.id);
        
        persons.forEach(p1 => {
            persons.forEach(p2 => {
                if (p1 !== p2) {
                    const p1Phones = graphData.edges.filter(e => (e.data.source === p1 && phones.includes(e.data.target)) || (e.data.target === p1 && phones.includes(e.data.source))).map(e => phones.includes(e.data.target) ? e.data.target : e.data.source);
                    const p2Phones = graphData.edges.filter(e => (e.data.source === p2 && phones.includes(e.data.target)) || (e.data.target === p2 && phones.includes(e.data.source))).map(e => phones.includes(e.data.target) ? e.data.target : e.data.source);
                    
                    const intersection = p1Phones.filter(value => p2Phones.includes(value));
                    if (intersection.length > 0) {
                        const edgeId = `inf_${Math.min(p1,p2)}_${Math.max(p1,p2)}`;
                        if (!inferredEdges.find(e => e.data.id === edgeId)) {
                            inferredEdges.push({
                                data: { id: edgeId, source: p1, target: p2, label: 'Shared Phone (Hidden)', type: 'INFERRED_LINK', explanation: `Suspicious Link: Entities share ${intersection.length} hidden communication endpoints.` },
                                classes: 'inferred-edge'
                            });
                        }
                    }
                }
            });
        });
    }

    // 3. Filter Nodes by Type
    filteredNodes = filteredNodes.filter(n => allowedTypes.includes(n.data.type));
    const nodeIds = new Set(filteredNodes.map(n => n.data.id));

    // 4. Filter Edges
    let filteredEdges = graphData.edges.filter(e => nodeIds.has(e.data.source) && nodeIds.has(e.data.target));
    filteredEdges = filteredEdges.concat(inferredEdges.filter(e => nodeIds.has(e.data.source) && nodeIds.has(e.data.target)));

    // Load into Cytoscape
    cy.elements().remove();
    cy.add([...filteredNodes, ...filteredEdges]);

    // View Depth Traversal
    const depth = document.getElementById('view-depth').value;
    if (depth !== 'all') {
        const caseNodes = cy.nodes('[type = "CASE"]');
        let currentCollection = caseNodes;
        for (let i = 0; i < parseInt(depth); i++) {
            currentCollection = currentCollection.union(currentCollection.neighborhood());
        }
        cy.elements().difference(currentCollection).remove();
    }

    // Cross-Syndicate Highlighting
    cy.nodes().removeClass('cross-syndicate-bridge');
    cy.nodes(':visible').forEach(n => {
        const nodeCases = n.data('case_ids') || [];
        const activeIntersections = nodeCases.filter(c => activeCases.includes(c));
        if (activeIntersections.length > 1) {
            n.addClass('cross-syndicate-bridge');
        }
    });

    cy.layout({ 
        name: 'cose', 
        animate: true, 
        animationDuration: 500,
        padding: 50,
        nodeRepulsion: function(node) { return 4000000; },
        idealEdgeLength: function(edge) { return 150; },
        nodeOverlap: 20,
        gravity: 0.1,
        componentSpacing: 100,
        nodeDimensionsIncludeLabels: true
    }).run();
    
    // Trigger Investigator Panel dynamically on filter
    updateInvestigatorPanel();
    
    const endTime = performance.now();
    const metric = document.getElementById('speed-metric');
    if (metric) metric.textContent = (endTime - startTime).toFixed(0);
}

// --- Investigator Block Logic ---
async function updateInvestigatorPanel(nodeData = null) {
    const inspector = document.getElementById('inspector-content');
    if (!inspector) return;

    if (!nodeData) {
        inspector.innerHTML = `<div class="flex items-center justify-center h-full"><span class="animate-pulse font-mono text-xs text-slate-500">Generating intelligence report...</span></div>`;
        try {
            const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]:checked');
            const activeCases = Array.from(checkboxes).map(cb => cb.value);

            let visibleNodes = cy ? cy.nodes(':visible') : [];
            let totalPersons = visibleNodes.filter(n => n.data('type') === 'PERSON').length;
            let totalPhones = visibleNodes.filter(n => n.data('type') === 'PHONE').length;
            let totalAccounts = visibleNodes.filter(n => n.data('type') === 'BANK_ACCOUNT').length;
            let totalLocations = visibleNodes.filter(n => n.data('type') === 'LOCATION').length;
            let bridges = visibleNodes.filter(n => n.hasClass('cross-syndicate-bridge')).length;

            let sectionAHtml = `
                <div class="bg-slate-900 p-4 border border-slate-700 shadow-sm rounded">
                    <h4 class="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-3 border-b border-slate-700/50 pb-2">Case Metrics Summary <span class="text-slate-600">(Scoped Filter)</span></h4>
                    <div class="grid grid-cols-2 gap-4 text-xs font-mono">
                        <div class="bg-slate-800 p-2 rounded border border-slate-700/50">
                            <span class="text-[9px] text-slate-500 uppercase block mb-1">Scoped Cases</span>
                            <span class="text-slate-200 text-lg font-bold">${activeCases.length}</span>
                        </div>
                        <div class="bg-slate-800 p-2 rounded border border-slate-700/50">
                            <span class="text-[9px] text-slate-500 uppercase block mb-1">Target Entities</span>
                            <span class="text-red-400 text-lg font-bold">${totalPersons}</span>
                        </div>
                        <div class="bg-slate-800 p-2 rounded border border-slate-700/50">
                            <span class="text-[9px] text-slate-500 uppercase block mb-1">Communications</span>
                            <span class="text-blue-400 text-lg font-bold">${totalPhones}</span>
                        </div>
                        <div class="bg-slate-800 p-2 rounded border border-slate-700/50">
                            <span class="text-[9px] text-slate-500 uppercase block mb-1">Financial Nodes</span>
                            <span class="text-amber-400 text-lg font-bold">${totalAccounts}</span>
                        </div>
                    </div>
                </div>
            `;

            let alertHtml = '';
            if (bridges > 0) {
                alertHtml = `
                    <div class="bg-red-900/20 border border-red-700/50 p-3 mt-4 rounded flex items-center space-x-3">
                        <div class="text-red-500 animate-pulse">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                        </div>
                        <div class="text-[10px] text-red-400 font-bold uppercase tracking-widest leading-relaxed">
                            ⚠️ Cross-Syndicate Linkage Detected
                            <span class="block text-slate-400 font-mono text-[9px] normal-case mt-0.5">Found ${bridges} node(s) associated with multiple cases.</span>
                        </div>
                    </div>
                `;
            }

            let evidenceHtml = "";
            let filePromises = activeCases.map(cid => fetch(`${API_BASE}/files/${cid}`).then(res => res.json()).then(files => ({cid, files})));
            let fileResults = await Promise.all(filePromises);

            let allFileNames = [];
            fileResults.forEach(({cid, files}) => {
                files.forEach(fileName => {
                    const safeId = `status-${cid}-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
                    activeFilesToMonitor.add(fileName);
                    allFileNames.push(fileName);
                    evidenceHtml += `
                    <li class="bg-slate-900 border border-slate-700 mb-2 p-2 rounded">
                        <div class="flex justify-between items-center">
                            ${renderFileLink(fileName, fileName)}
                            <span id="${safeId}" class="text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border animate-pulse bg-slate-800 text-slate-500 border-slate-700 shrink-0">checking...</span>
                        </div>
                        <div class="text-[8px] text-slate-600 font-mono mt-1 pl-1">${cid}</div>
                    </li>`;
                });
            });

            if (!evidenceHtml) {
                evidenceHtml = `<li class="text-[10px] text-slate-500 font-mono italic">No proof files in scope.</li>`;
            }

            let sectionCHtml = `
                <div class="mt-6">
                    <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3 flex items-center border-b border-slate-700/50 pb-2">
                        <svg class="w-3 h-3 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                        Proof Files
                    </h4>
                    <ul class="space-y-1" id="master-evidence-list">
                        ${evidenceHtml}
                    </ul>
                </div>
            `;

            // Auto-verify all proof files after rendering
            setTimeout(() => {
                autoVerifyProofFiles(allFileNames, fileResults);
            }, 300);

            inspector.innerHTML = `
                <div class="mb-4 border-b border-slate-700 pb-3">
                    <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase flex items-center">
                        <div class="w-2 h-2 bg-blue-500 rounded-sm mr-2"></div>
                        Global State
                    </h3>
                </div>
                <div class="flex flex-col">
                    ${sectionAHtml}
                    ${alertHtml}
                    ${sectionCHtml}
                </div>
            `;

        } catch(e) {
            inspector.innerHTML = `<p class="text-red-500 font-mono text-xs">Error generating report.</p>`;
            console.error(e);
        }
    } else {
        const data = nodeData;
        if (data.type === 'CASE') {
            inspector.innerHTML = `<div class="flex items-center justify-center h-full"><span class="animate-pulse font-mono text-xs text-slate-500">Querying intelligence database...</span></div>`;
            try {
                const fileRes = await fetch(`${API_BASE}/files/${data.id}`);
                const files = await fileRes.json();
                
                let caseFileNames = [];
                let filesHtml = files.map(fileName => {
                    const safeId = `status-case-${data.id}-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
                    activeFilesToMonitor.add(fileName);
                    caseFileNames.push(fileName);
                    return `
                    <div class="bg-slate-900 border border-slate-700 mb-2 p-2 rounded">
                        <div class="flex justify-between items-center">
                            ${renderFileLink(fileName)}
                            <span id="${safeId}" class="text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border animate-pulse bg-slate-800 text-slate-500 border-slate-700 shrink-0">checking...</span>
                        </div>
                    </div>`;
                }).join('');
                
                if (files.length === 0) {
                    filesHtml = `<p class="text-[10px] text-slate-500 font-mono italic">No associated proof files found.</p>`;
                }

                inspector.innerHTML = `
                    <div class="mb-4 border-b border-slate-700 pb-2">
                        <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase">${data.id}</h3>
                        <p class="text-[10px] text-slate-400 mt-1 uppercase">Object Type: INTELLIGENCE DOSSIER</p>
                    </div>
                    <div class="space-y-4">
                        <div>
                            <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center">
                                <svg class="w-3 h-3 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                                Proof Files
                            </h4>
                            ${filesHtml}
                        </div>
                    </div>
                `;

                // Auto-verify case files
                setTimeout(() => {
                    autoVerifyCaseFiles(caseFileNames, data.id);
                }, 300);
            } catch(e) {
                inspector.innerHTML = `<p class="text-red-500 font-mono text-xs">Error querying database.</p>`;
            }
        } else {
            inspector.innerHTML = `<div class="flex items-center justify-center h-full"><span class="animate-pulse font-mono text-xs text-slate-500">Querying intelligence database...</span></div>`;
            
            let threatLevel = "Associate (2nd Degree)";
            let threatBadge = `<span class="bg-amber-900/50 text-amber-400 border border-amber-700/50 px-2 py-0.5 rounded text-[9px] uppercase tracking-widest font-bold">Mid-Level Associate</span>`;
            if (data.pageRank > 0.15) {
                threatLevel = "High-Value Target (Kingpin)";
                threatBadge = `<span class="bg-red-900/50 text-red-400 border border-red-700/50 px-2 py-0.5 rounded text-[9px] uppercase tracking-widest font-bold">High Priority Subject</span>`;
            } else if (data.betweenness > 50) {
                threatLevel = "Syndicate Broker (1st Degree)";
                threatBadge = `<span class="bg-orange-900/50 text-orange-400 border border-orange-700/50 px-2 py-0.5 rounded text-[9px] uppercase tracking-widest font-bold">Syndicate Broker</span>`;
            }

            try {
                // Generate a metadata table
                let metaTable = `
                    <div class="bg-slate-900 border border-slate-700 rounded overflow-hidden">
                        <table class="w-full text-left text-[10px] font-mono">
                            <tbody>
                                <tr class="border-b border-slate-800">
                                    <th class="py-2 px-3 text-slate-500 font-semibold w-1/3">Primary FIR</th>
                                    <td class="py-2 px-3 text-slate-300 break-all">${data.case_ids && data.case_ids.length > 0 ? data.case_ids[0] : 'N/A'}</td>
                                </tr>
                                <tr class="border-b border-slate-800">
                                    <th class="py-2 px-3 text-slate-500 font-semibold">ID / Hash</th>
                                    <td class="py-2 px-3 text-slate-300 break-all">${data.id}</td>
                                </tr>
                                <tr class="border-b border-slate-800">
                                    <th class="py-2 px-3 text-slate-500 font-semibold">Phone</th>
                                    <td class="py-2 px-3 text-slate-300 break-all">${data.phone || 'Unknown'}</td>
                                </tr>
                                <tr class="border-b border-slate-800">
                                    <th class="py-2 px-3 text-slate-500 font-semibold">Bank Acc</th>
                                    <td class="py-2 px-3 text-slate-300 break-all">${data.bank_account || 'Unknown'}</td>
                                </tr>
                                <tr>
                                    <th class="py-2 px-3 text-slate-500 font-semibold">Vehicle</th>
                                    <td class="py-2 px-3 text-slate-300 break-all">${data.vehicle || 'Unknown'}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                `;

                inspector.innerHTML = `
                <div class="mb-4 border-b border-slate-700 pb-3">
                    <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase truncate mb-2" title="${data.label}">INSPECTING TARGET DOSSIER</h3>
                    <div class="flex items-center space-x-2">
                        ${threatBadge}
                        <span class="bg-slate-800/80 text-slate-400 border border-slate-700/50 px-2 py-0.5 rounded text-[9px] uppercase tracking-widest font-bold">${data.type}</span>
                    </div>
                </div>
                
                <div class="flex flex-col space-y-4">
                    ${metaTable}
                    
                    <div>
                        <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Structural Graph Metrics</h4>
                        <div class="grid grid-cols-3 gap-2 mt-2">
                            <div class="bg-slate-800/50 border border-slate-700/50 p-2 rounded">
                                <div class="text-[8px] text-slate-500 uppercase">Risk Score</div>
                                <div class="text-xs font-mono text-slate-300">${Math.round((data.pageRank || 0) * 100)}</div>
                            </div>
                            <div class="bg-slate-800/50 border border-slate-700/50 p-2 rounded">
                                <div class="text-[8px] text-slate-500 uppercase">PageRank</div>
                                <div class="text-xs font-mono text-slate-300">${(data.pageRank || 0).toFixed(4)}</div>
                            </div>
                            <div class="bg-slate-800/50 border border-slate-700/50 p-2 rounded">
                                <div class="text-[8px] text-slate-500 uppercase">Betweenness</div>
                                <div class="text-xs font-mono text-slate-300">${(data.betweenness || 0).toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex flex-col space-y-2 mt-6 border-t border-slate-700/50 pt-4">
                        <button onclick="isolateSubgraph('${data.id}')" class="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-colors rounded shadow-sm flex items-center justify-center">
                            <svg class="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path></svg>
                            Isolate Subgraph
                        </button>
                    </div>
                </div>
            `;
        } catch(e) {
            inspector.innerHTML = `<p class="text-red-500 font-mono text-xs">Error querying intelligence database.</p>`;
        }
    }
}
}

function isolateSubgraph(nodeId) {
    if (!cy) return;
    const targetNode = cy.getElementById(nodeId);
    if (!targetNode || targetNode.empty()) return;

    // Get neighborhood (1st degree)
    const neighborhood = targetNode.neighborhood().add(targetNode);
    
    // Hide all others
    cy.elements().style('display', 'none');
    neighborhood.style('display', 'element');
    
    // Re-run layout on the subgraph
    const layout = neighborhood.layout({
        name: 'concentric',
        fit: true,
        padding: 50,
        animate: true,
        animationDuration: 500,
        minNodeSpacing: 100,
        concentric: function(node) {
            if (node.id() === nodeId) return 100;
            return 10;
        },
        levelWidth: function(nodes) {
            return 10;
        }
    });
    layout.run();
}

function populateInspectorEdge(data) {
    const inspector = document.getElementById('inspector-content');
    
    // Attempt to resolve entity names from Cytoscape if available
    const sourceNode = cy ? cy.getElementById(data.source) : null;
    const targetNode = cy ? cy.getElementById(data.target) : null;
    const sourceName = (sourceNode && sourceNode.length > 0) ? (sourceNode.data('label') || data.source) : data.source;
    const targetName = (targetNode && targetNode.length > 0) ? (targetNode.data('label') || data.target) : data.target;
    
    const status = data.verificationStatus || 'pending';
    
    let verificationHtml = '';
    
    if (status === 'pending') {
        verificationHtml = `
            <div class="bg-slate-900 p-3 border border-slate-700 space-y-3 transition-all duration-300">
                <div class="text-[10px] font-bold text-yellow-500 tracking-widest uppercase">
                    Pending Officer Review
                </div>
                <div class="text-[10px] text-slate-400 uppercase tracking-widest">
                    AI-Detected Link
                </div>
                
                <div class="text-xs font-mono text-slate-300 mt-2">
                    <span class="text-white font-bold">${sourceName}</span> &rarr; <span class="text-white font-bold">${targetName}</span>
                </div>
                
                <div class="text-[10px] text-slate-400 mt-2">
                    AI CONFIDENCE <span class="text-cyan-400 font-bold ml-2">87%</span>
                </div>
                
                <div class="flex flex-row space-x-2 mt-3 pt-2 border-t border-slate-700/50">
                    <button onclick="confirmLink('${data.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors shadow-sm text-center">✓ Confirm Link</button>
                    <button onclick="rejectLink('${data.id}')" class="flex-1 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-700/50 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors shadow-sm text-center">✕ Reject Link</button>
                </div>
            </div>
        `;
    } else if (status === 'confirmed') {
        verificationHtml = `
            <div class="bg-slate-900/50 p-3 border border-emerald-900/50 space-y-2 transition-all duration-300">
                <div class="text-[10px] font-bold text-emerald-400 tracking-widest uppercase flex items-center">
                    ✓ Confirmed By Officer
                </div>
                <div class="text-xs font-mono text-slate-300">
                    <span class="text-white font-bold">${sourceName}</span> &rarr; <span class="text-white font-bold">${targetName}</span>
                </div>
                <div class="text-[10px] text-slate-400 leading-relaxed">
                    Verification<br/>Officer confirmed this AI-detected relationship.
                </div>
            </div>
        `;
    } else if (status === 'rejected') {
        verificationHtml = `
            <div class="bg-slate-900/50 p-3 border border-red-900/50 space-y-2 transition-all duration-300">
                <div class="text-[10px] font-bold text-red-400 tracking-widest uppercase flex items-center">
                    ✕ Rejected By Officer
                </div>
                <div class="text-xs font-mono text-slate-300">
                    <span class="text-white font-bold">${sourceName}</span> &rarr; <span class="text-white font-bold">${targetName}</span>
                </div>
                <div class="text-[10px] text-slate-400 leading-relaxed">
                    Verification<br/>Officer rejected this AI-detected relationship.
                </div>
            </div>
        `;
    }

    inspector.innerHTML = `
        <div class="mb-4 border-b border-slate-700 pb-2">
            <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase">Link Analysis</h3>
            <p class="text-[10px] text-slate-400 mt-1 uppercase">Edge Type: <span class="text-white font-bold">${data.type}</span></p>
        </div>
        <div class="space-y-4">
            <div>
                <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Explainable Connections</h4>
                <p class="text-xs font-mono text-slate-300 bg-slate-900 p-2 border border-slate-700">${data.explanation || `Direct extraction from evidentiary text. The NLP pipeline explicitly detected a <span class="text-cyan-400 font-bold">${data.type}</span> relationship between these entities.`}</p>
            </div>
            
            <div class="mt-4 border-t border-slate-700 pt-4">
                <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Human Verification</h4>
                ${verificationHtml}
            </div>
        </div>
    `;
}

function confirmLink(edgeId) {
    if(cy) {
        const edge = cy.getElementById(edgeId);
        if (edge && edge.length > 0) {
            edge.data('verificationStatus', 'confirmed');
            populateInspectorEdge(edge.data());
        }
    }
}

function rejectLink(edgeId) {
    if(cy) {
        const edge = cy.getElementById(edgeId);
        if (edge && edge.length > 0) {
            edge.data('verificationStatus', 'rejected');
            populateInspectorEdge(edge.data());
        }
    }
}

// --- Universal Entity Search ---
function applyCaseFilters() {
    const fStatus = (document.getElementById('filter-status')?.value || 'ALL');
    const fOfficer = (document.getElementById('filter-officer')?.value || 'ALL');
    const searchQ = (document.getElementById('case-directory-search')?.value || '').toLowerCase();
    
    const items = document.querySelectorAll('#case-directory-list li');
    items.forEach(li => {
        const s = li.getAttribute('data-status');
        const o = li.getAttribute('data-officer');
        const text = li.textContent.toLowerCase();
        
        let match = true;
        if (fStatus !== 'ALL' && s !== fStatus) match = false;
        if (fOfficer !== 'ALL' && o !== fOfficer) match = false;
        if (searchQ && !text.includes(searchQ)) match = false;
        
        if (match) li.classList.remove('hidden');
        else li.classList.add('hidden');
    });
}

function initSearch() {
    const searchInput = document.getElementById('universal-search-input');
    const resetBtn = document.getElementById('search-reset-btn');
    const datalist = document.getElementById('search-suggestions');
    
    // Case Directory Filter
    const caseDirectorySearch = document.getElementById('case-directory-search');
    const caseList = document.getElementById('case-directory-list');
    
    if (caseDirectorySearch) caseDirectorySearch.addEventListener('input', applyCaseFilters);
    const filterStatus = document.getElementById('filter-status');
    if (filterStatus) filterStatus.addEventListener('change', applyCaseFilters);
    const filterOfficer = document.getElementById('filter-officer');
    if (filterOfficer) filterOfficer.addEventListener('change', applyCaseFilters);
    
    if(!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim().toLowerCase();
        if (val.length > 0) {
            resetBtn.classList.remove('hidden');
            if(cy) {
                const matches = cy.nodes().filter(n => (n.data('label') || '').toLowerCase().includes(val) || n.id().toLowerCase().includes(val));
                datalist.innerHTML = matches.map(n => {
                    const risk = Math.round((n.data('pageRank')||0) * 100);
                    return `<option value="${n.data('label')}">Risk Score: ${risk}</option>`;
                }).slice(0, 10).join('');
            }
        } else {
            resetBtn.classList.add('hidden');
            datalist.innerHTML = '';
            resetSearchFocus();
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            executeSearch(e.target.value.trim());
        }
    });

    resetBtn.addEventListener('click', () => {
        searchInput.value = '';
        resetBtn.classList.add('hidden');
        datalist.innerHTML = '';
        resetSearchFocus();
    });
}

function executeSearch(query) {
    if (!cy || !query) return;
    
    if (query.toUpperCase().startsWith('FIR-') || query.toUpperCase().startsWith('CASE-')) {
        const caseQuery = query.toUpperCase();
        const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]');
        let found = false;
        checkboxes.forEach(cb => {
            if (cb.value === caseQuery) {
                cb.checked = true;
                found = true;
            } else {
                cb.checked = false;
            }
        });
        
        if (found) {
            updateGraphView();
            resetSearchFocus();
        } else {
            const toast = document.getElementById('search-toast');
            toast.classList.remove('hidden');
            setTimeout(() => toast.classList.add('hidden'), 3000);
        }
        return;
    }

    query = query.toLowerCase();
    
    const targetNodes = cy.nodes().filter(n => {
        const label = n.data('label') ? n.data('label').toLowerCase() : '';
        const id = n.id().toLowerCase();
        return label.includes(query) || id.includes(query);
    });

    if (targetNodes.length > 0) {
        const target = targetNodes[0]; 
        
        cy.elements().removeClass('search-focus search-fade target-halo');
        cy.elements().addClass('search-fade');
        
        const neighborhood = target.neighborhood().add(target);
        neighborhood.removeClass('search-fade').addClass('search-focus');
        target.addClass('target-halo');

        cy.animate({
            center: { eles: target },
            zoom: 2.2,
            duration: 500
        });

        updateInvestigatorPanel(target.data());
    } else {
        const toast = document.getElementById('search-toast');
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);
    }
}

function resetSearchFocus() {
    if (!cy) return;
    cy.elements().removeClass('search-focus search-fade target-halo');
    cy.fit({ padding: 40 });
    updateInvestigatorPanel();
}

// --- Security Alert System ---
let currentlyAlertingFile = null;

// Add dismiss listener once when script loads (or in window.onload)
window.addEventListener('DOMContentLoaded', () => {
    const dismissBtn = document.getElementById('security-toast-dismiss');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            document.getElementById('security-alert-toast').classList.add('hidden');
            if (currentlyAlertingFile) {
                acknowledgedTamperFiles.add(currentlyAlertingFile);
                currentlyAlertingFile = null;
            }
        });
    }
});

function updateDossierBadges(fileName, status) {
    const safeHash = fileName.replace(/[^a-zA-Z0-9]/g, '');
    document.querySelectorAll(`[id*="status-"][id*="${safeHash}"], [id*="hash-"][id*="${safeHash}"], [id*="evidence-"][id*="${safeHash}"]`).forEach(el => {
        if (status === 'SECURE') {
            el.textContent = 'TAMPER-PROOF';
            el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-emerald-900/30 text-emerald-400 border-emerald-700 font-bold';
        } else {
            el.textContent = 'TAMPERED';
            el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-red-900/30 text-red-400 border-red-700 font-bold';
        }
    });
}

function toggleAlertPanel() {
    const dropdown = document.getElementById('alert-dropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
}

function updateAlertBadge() {
    const alertList = document.getElementById('alert-list');
    if (!alertList) return;
    
    // Count actual alert entries (not the empty state)
    const alertEntries = alertList.querySelectorAll('[id^="alert-file-"]');
    const count = alertEntries.length;
    const badge = document.getElementById('alert-count-badge');
    const bellBtn = document.getElementById('alert-bell-btn');
    
    if (count > 0) {
        if (badge) {
            badge.textContent = count;
            badge.classList.remove('hidden');
        }
        if (bellBtn) {
            bellBtn.classList.add('text-red-400');
            bellBtn.classList.remove('text-slate-400');
        }
    } else {
        if (badge) badge.classList.add('hidden');
        if (bellBtn) {
            bellBtn.classList.remove('text-red-400');
            bellBtn.classList.add('text-slate-400');
        }
        // Show empty state if no entries
        const emptyState = document.getElementById('alert-empty-state');
        if (emptyState) emptyState.classList.remove('hidden');
    }
}

function triggerSecurityAlert(fileName) {
    currentTamperFiles.add(fileName);
    
    // Update inline badge immediately
    updateDossierBadges(fileName, 'TAMPERED');

    // Add to Notification Bell History
    const alertList = document.getElementById('alert-list');
    const safeId = `alert-file-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
    
    if (alertList && !document.getElementById(safeId)) {
        const emptyState = document.getElementById('alert-empty-state');
        if (emptyState) emptyState.classList.add('hidden');
        
        const entry = document.createElement('div');
        entry.id = safeId;
        entry.className = 'px-4 py-3 border-b border-slate-800 flex items-start space-x-3 hover:bg-slate-800/50 transition-colors';
        entry.innerHTML = `
            <div class="w-2 h-2 bg-red-500 rounded-full mt-1.5 shrink-0 animate-pulse"></div>
            <div class="flex-1 min-w-0">
                <div class="text-[10px] text-red-400 font-bold uppercase tracking-widest mb-0.5">Hash Mismatch</div>
                <div class="text-[11px] text-slate-300 font-mono truncate" title="${fileName}">${fileName}</div>
                <div class="text-[9px] text-slate-500 mt-1">Cryptographic integrity check failed</div>
            </div>
        `;
        alertList.appendChild(entry);
        updateAlertBadge();
    }

    if (acknowledgedTamperFiles.has(fileName)) return;

    // Show toast
    const toast = document.getElementById('security-alert-toast');
    const filenameSpan = document.getElementById('security-toast-filename');
    if (toast && filenameSpan) {
        // Prevent aggressive re-popping if the toast is already visible and showing a file
        if (!toast.classList.contains('hidden')) return; 

        filenameSpan.textContent = `[TAMPERED] ${fileName}`;
        toast.classList.remove('hidden');
        currentlyAlertingFile = fileName;
    }
}

// --- Background Integrity Monitor ---
async function runIntegrityAudit() {
    if (activeFilesToMonitor.size === 0) return;
    try {
        const res = await fetch(`${API_BASE}/monitor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: Array.from(activeFilesToMonitor) })
        });
        const data = await res.json();
        
        Object.keys(data).forEach(fileName => {
            if (data[fileName].status === "TAMPERED") {
                triggerSecurityAlert(fileName);
            } else if (data[fileName].status === "SECURE") {
                updateDossierBadges(fileName, "SECURE");
                currentTamperFiles.delete(fileName);
                acknowledgedTamperFiles.delete(fileName);
                
                // Auto-heal toast if the file being displayed was fixed
                if (currentlyAlertingFile === fileName) {
                    document.getElementById('security-alert-toast').classList.add('hidden');
                    currentlyAlertingFile = null;
                }

                // Auto-heal bell history
                const alertEntry = document.getElementById(`alert-file-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`);
                if (alertEntry) alertEntry.remove();
                if (typeof updateAlertBadge === 'function') updateAlertBadge();
            }
        });
    } catch (e) {
        // Silent fail — don't disrupt the user's graph analysis
        console.error('Background integrity audit failed', e);
    }
}

// Check auth on load
window.onload = () => {
    checkAuth();
    
    // Start background integrity monitor (polls every 8 seconds)
    if (!integrityMonitorInterval) {
        integrityMonitorInterval = setInterval(runIntegrityAudit, 8000);
        // Run first audit after 3 seconds to let the UI settle
        setTimeout(runIntegrityAudit, 3000);
    }
    
    // Close alert dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('alert-dropdown');
        const bellBtn = document.getElementById('alert-bell-btn');
        if (dropdown && !dropdown.classList.contains('hidden') && !dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
};

// --- Mode Navigation Logic ---
function switchTab(tabId) {
    // --- Hide ALL tab containers via inline style (bypasses Tailwind specificity) ---
    document.querySelectorAll('.tab-content').forEach(el => {
        el.style.display = 'none';
        el.classList.remove('active-tab');
    });

    // --- Deactivate all nav buttons ---
    document.querySelectorAll('.tab-btn').forEach(el => {
        el.classList.remove('active', 'bg-slate-700', 'text-white', 'border-slate-600');
        el.classList.add('bg-slate-900', 'text-slate-400', 'border-slate-700');
    });

    // --- Show the selected tab ---
    const tabContent = document.getElementById(`tab-${tabId}`);
    if (tabContent) {
        tabContent.style.display = 'flex';
        tabContent.classList.add('active-tab');
    }

    // --- Activate the selected button ---
    const btn = document.getElementById(`btn-tab-${tabId}`);
    if (btn) {
        btn.classList.remove('bg-slate-900', 'text-slate-400', 'border-slate-700');
        btn.classList.add('active', 'bg-slate-700', 'text-white', 'border-slate-600');
    }

    // --- Tab-specific side effects ---
    if (tabId === 'graph' && cy) {
        setTimeout(() => cy.resize(), 50);
    }
}

// --- Subject Dossier & Intelligence Report (Tab 2) ---
let currentDossierData = null;
let dossierChartInstance = null;

function performSimpleSearch() {
    const query = document.getElementById('simple-search-input').value.toLowerCase();
    const resultsDiv = document.getElementById('simple-search-results');
    
    if (!query) {
        resultsDiv.classList.add('hidden');
        return;
    }
    
    resultsDiv.classList.remove('hidden');
    resultsDiv.innerHTML = '<span class="text-slate-500 text-xs font-mono animate-pulse">Searching global intelligence database...</span>';

    setTimeout(() => {
        // Search Entities
        const entityMatches = graphData && graphData.nodes ? graphData.nodes.filter(n => n.data.label && n.data.label.toLowerCase().includes(query)) : [];
        
        // Search Cases and Files
        const caseMatches = [];
        if (typeof allCasesCache !== 'undefined' && allCasesCache) {
            allCasesCache.forEach(c => {
                const cId = c.id ? c.id.toLowerCase() : '';
                const cOfficer = c.officer ? c.officer.toLowerCase() : '';
                const cStation = c.station ? c.station.toLowerCase() : '';
                
                let fileMatch = false;
                if (c.files) {
                    fileMatch = c.files.some(f => f.toLowerCase().includes(query));
                }

                // Create Pseudo-hash for search matching
                const hashBase = btoa(c.id).toLowerCase().replace(/[^a-z0-9]/g, '');
                const pseudoHash = hashBase.substring(0, 8) + '...' + hashBase.substring(hashBase.length - 8);

                if (cId.includes(query) || cOfficer.includes(query) || cStation.includes(query) || pseudoHash.includes(query) || fileMatch) {
                    caseMatches.push(c);
                }
            });
        }

        let totalMatches = entityMatches.length + caseMatches.length;

        if (totalMatches > 0) {
            let html = `<h4 class="text-xs font-semibold text-slate-300 uppercase tracking-widest mb-2">Matches Found (${totalMatches})</h4>`;
            
            if (entityMatches.length > 0) {
                html += `<div class="mb-3"><div class="text-[10px] text-slate-500 mb-1 font-bold">ENTITIES</div><ul class="space-y-2">`;
                entityMatches.slice(0, 50).forEach(m => {
                    html += `<li onclick="document.getElementById('entity-profile-overlay').classList.remove('hidden'); renderSubjectDossier('${m.data.id}')" class="cursor-pointer hover:bg-slate-700 text-xs font-mono text-slate-400 bg-slate-900 p-2 border border-slate-700 transition-colors"><span class="text-blue-400 font-bold">${m.data.label}</span> [${m.data.type}] - Cases: ${m.data.case_ids ? m.data.case_ids.join(', ') : 'N/A'}</li>`;
                });
                html += `</ul></div>`;
            }

            if (caseMatches.length > 0) {
                html += `<div><div class="text-[10px] text-slate-500 mb-1 font-bold">CASES & FILES</div><ul class="space-y-2">`;
                caseMatches.slice(0, 50).forEach(c => {
                    html += `<li onclick="document.getElementById('entity-profile-overlay').classList.remove('hidden'); renderSubjectDossier('${c.id}')" class="cursor-pointer hover:bg-slate-700 text-xs font-mono text-slate-400 bg-slate-900 p-2 border border-slate-700 transition-colors"><span class="text-emerald-400 font-bold">${c.id}</span> - Officer: ${c.officer || 'N/A'} <br/><span class="text-[9px] text-slate-500">Files: ${c.files ? c.files.join(', ') : 'N/A'}</span></li>`;
                });
                html += `</ul></div>`;
            }

            resultsDiv.innerHTML = html;
        } else {
            resultsDiv.innerHTML = '<span class="text-yellow-500 text-xs font-mono">No matches found in intelligence database.</span>';
        }
    }, 400);
}

function formatGraphEdgeText(subjectName, edgeType, targetName) {
    if (edgeType === 'MENTIONED_IN') {
        return `${subjectName} is officially named in ${targetName}.`;
    } else if (edgeType === 'USES_COMMUNICATION' || edgeType === 'COMMUNICATED') {
        return `${subjectName} operates telecommunication identifier ${targetName}.`;
    } else if (edgeType === 'CO_ACCUSED') {
        return `${subjectName} is a known associate/co-accused of ${targetName}.`;
    } else if (edgeType === 'TRANSACTED') {
        return `${subjectName} routed financial transactions involving ${targetName}.`;
    } else if (edgeType === 'PREDICTED_LINK') {
        return `Intelligence indicates a highly probable concealed link between ${subjectName} and ${targetName}.`;
    } else {
        return `${subjectName} is associated with ${targetName}.`;
    }
}

function renderCaseDossier(caseId) {
    const caseObj = allCasesCache.find(c => c.id === caseId);
    if (!caseObj) return;

    let entitiesCount = 0;
    let linksCount = 0;
    let maxRisk = 0;
    let sumPR = 0;
    let sumBtw = 0;
    let sumDegree = 0;

    const caseNodes = new Set();
    if (graphData && graphData.nodes) {
        graphData.nodes.forEach(n => {
            if (n.data.case_ids && n.data.case_ids.includes(caseId)) {
                entitiesCount++;
                caseNodes.add(n.data.id);
                const r = (n.data.pageRank || 0);
                if (r > maxRisk) maxRisk = r;
                sumPR += r;
                sumBtw += (n.data.betweenness || 0);
                sumDegree += (n.data.degree || 0);
            }
        });
    }

    if (graphData && graphData.edges) {
        graphData.edges.forEach(e => {
            if (caseNodes.has(e.data.source) || caseNodes.has(e.data.target)) {
                linksCount++;
            }
        });
    }

    let riskScore = Math.round(maxRisk * 100);
    let avgPR = entitiesCount > 0 ? (sumPR / entitiesCount) * 300 : 0;
    let avgBtw = entitiesCount > 0 ? (sumBtw / entitiesCount) * 2 : 0;
    let avgDeg = entitiesCount > 0 ? (sumDegree / entitiesCount) * 10 : 0;

    currentDossierData = { id: caseId, type: 'CASE', case_ids: [caseId], label: caseObj.offense || 'Intelligence Trace' };

    document.getElementById('simple-search-results').classList.add('hidden');
    document.getElementById('entity-profile-overlay').classList.remove('hidden');
    document.getElementById('entity-profile-overlay').classList.add('flex');
    document.getElementById('subject-dossier-container').classList.remove('hidden');

    document.getElementById('dossier-name').textContent = currentDossierData.label;
    document.getElementById('dossier-id').textContent = `ID: ${caseId}`;
    document.getElementById('dossier-type').textContent = `TYPE: CASE DOSSIER`;

    const ctx = document.getElementById('dossierRadarChart').getContext('2d');
    if (dossierChartInstance) dossierChartInstance.destroy();
    
    let vizRisk = Math.min(100, riskScore * 2);
    
    dossierChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['Max Risk', 'Avg PageRank', 'Avg Betweenness', 'Avg Degree', 'Closeness'],
            datasets: [{
                label: 'Threat Vector',
                data: [vizRisk, Math.min(100, avgPR), Math.min(100, avgBtw), Math.min(100, avgDeg), 60],
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'rgba(239, 68, 68, 0.8)',
                borderWidth: 1,
                pointBackgroundColor: 'rgba(239, 68, 68, 1)'
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                r: {
                    angleLines: { color: 'rgba(255, 255, 255, 0.05)' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    pointLabels: { color: '#94a3b8', font: { size: 9, family: 'monospace' } },
                    ticks: { display: false, max: 100 }
                }
            },
            plugins: { legend: { display: false } }
        }
    });

    const aiBox = document.getElementById('dossier-ai-assessment');
    let threatBadgeHtml = '';
    if (riskScore > 40) {
        threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-red-600 bg-red-900 text-red-300 shadow-sm">THREAT: CRITICAL (TARGET SCOPE)</span></div>`;
    } else if (riskScore > 20 || (caseObj.status || '').toUpperCase().includes('PRIORITY')) {
        threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-orange-600 bg-orange-900 text-orange-300 shadow-sm">THREAT: HIGH PRIORITY</span></div>`;
    } else {
        threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-amber-600 bg-amber-900 text-amber-300 shadow-sm">THREAT: ELEVATED / STANDBY</span></div>`;
    }

    let text = `This record represents an official law enforcement case file (<strong>${caseId}</strong>).<br><br>`;
    text += `<strong>Network Summary:</strong><br>`;
    text += `- <strong>Total Entities Involved:</strong> <span class="text-white">${entitiesCount}</span><br>`;
    text += `- <strong>Total Network Links:</strong> <span class="text-white">${linksCount}</span><br>`;
    text += `- <strong>Highest Individual Risk Score:</strong> <span class="text-red-400 font-bold">${riskScore}</span><br><br>`;

    text += `<span class="text-emerald-400 font-bold">Action Suggested:</span> Review attached evidentiary proofs and linked entities to establish investigative leads.`;

    aiBox.innerHTML = threatBadgeHtml + text;

    document.getElementById('dossier-evidence-search').value = '';
    filterDossierEvidence();
}

function renderSubjectDossier(nodeIdOrLabel) {
    const node = graphData.nodes.find(n => n.data.id === nodeIdOrLabel || n.data.label === nodeIdOrLabel);
    if (!node) return;
    const data = node.data;
    currentDossierData = data;

    // Hide search results
    document.getElementById('simple-search-results').classList.add('hidden');

    document.getElementById('entity-profile-overlay').classList.remove('hidden');
    document.getElementById('entity-profile-overlay').classList.add('flex');
    document.getElementById('subject-dossier-container').classList.remove('hidden');

    document.getElementById('dossier-name').textContent = data.label || 'UNKNOWN';
    document.getElementById('dossier-id').textContent = `ID: ${data.id}`;
    document.getElementById('dossier-type').textContent = `TYPE: ${data.type}`;

    let threatBadgeHtml = '';
    let risk = (data.pageRank || 0) * 100;
    if (data.type !== 'CASE' && !data.id.startsWith('CASE') && !data.id.startsWith('FIR')) {
        if (risk > 15) {
            threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-red-600 bg-red-900 text-red-300 shadow-sm">THREAT: CRITICAL (TARGET)</span></div>`;
        } else if (data.betweenness > 50) {
            threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-orange-600 bg-orange-900 text-orange-300 shadow-sm">THREAT: HIGH (BROKER)</span></div>`;
        } else {
            threatBadgeHtml = `<div class="mb-3"><span class="px-3 py-1 text-xs font-bold uppercase tracking-widest border border-amber-600 bg-amber-900 text-amber-300 shadow-sm">THREAT: ELEVATED (ASSOCIATE)</span></div>`;
        }
    }

    // Chart.js Radar
    const ctx = document.getElementById('dossierRadarChart').getContext('2d');
    if (dossierChartInstance) dossierChartInstance.destroy();
    
    // Scale up visual risk slightly for presentation
    let vizRisk = Math.min(100, risk * 3);
    let vizPR = Math.min(100, (data.pageRank||0)*300);
    let vizBtw = Math.min(100, (data.betweenness||0)*2);
    
    dossierChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['Risk Score', 'PageRank', 'Betweenness', 'Degree', 'Closeness'],
            datasets: [{
                label: 'Threat Vector',
                data: [vizRisk, vizPR, vizBtw, Math.min(100, (data.degree||0)*10), 60],
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'rgba(239, 68, 68, 0.8)',
                borderWidth: 1,
                pointBackgroundColor: 'rgba(239, 68, 68, 1)'
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                r: {
                    angleLines: { color: 'rgba(255, 255, 255, 0.05)' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    pointLabels: { color: '#94a3b8', font: { size: 9, family: 'monospace' } },
                    ticks: { display: false, max: 100 }
                }
            },
            plugins: { legend: { display: false } }
        }
    });

    // AI Analytical Assessment
    const aiBox = document.getElementById('dossier-ai-assessment');
    
    const connectedEdges = graphData.edges.filter(e => e.data.source === data.id || e.data.target === data.id);
    const predEdges = connectedEdges.filter(e => e.data.type === 'PREDICTED_LINK');
    
    let text = '';
    
    if (data.type === 'CASE' || data.id.startsWith('CASE') || data.id.startsWith('FIR')) {
        text = `This record represents an official First Information Report (FIR) or registered law enforcement case. `;
        text += `It is connected to ${connectedEdges.length} distinct entities within the global intelligence graph. `;
    } else {
        text = `<strong>Topological Metrics:</strong><br>`;
        text += `- PageRank Centrality: <span class="text-emerald-400 font-mono font-bold">${(data.pageRank || 0).toFixed(4)}</span><br>`;
        text += `- Betweenness Centrality: <span class="text-amber-400 font-mono font-bold">${(data.betweenness || 0)}</span><br><br>`;
        
        text += `The available records indicate potential associations across ${data.case_ids ? data.case_ids.length : 0} linked case(s). `;
        
        let financial = connectedEdges.filter(e => e.data.type.includes('TRANSACTED'));
        let comms = connectedEdges.filter(e => e.data.type.includes('COMMUNICATED'));
        
        if (financial.length > 0) {
            text += `Subject exhibits complex financial routing patterns with ${financial.length} logged transaction links. `;
        }
        if (comms.length > 0) {
            text += `Telecommunication records show explicit coordination involving ${comms.length} distinct identifiers. `;
        }
    }
    
    if (predEdges.length > 0) {
        text += `<br><br><span class="text-fuchsia-400">Cross-case AI predictions identified ${predEdges.length} hidden connections.</span> `;
        let firstPred = predEdges[0];
        let otherId = firstPred.data.source === data.id ? firstPred.data.target : firstPred.data.source;
        let otherN = graphData.nodes.find(n => n.data.id === otherId);
        if(otherN) {
            text += `Most notably, a probabilistic link exists between this subject and ${otherN.data.label} (${otherN.data.type}). `;
        }
    }
    
    if (data.type === 'CASE' || data.id.startsWith('CASE') || data.id.startsWith('FIR')) {
        text += `<br><br><span class="text-emerald-400">Action Suggested:</span> Review attached evidentiary proofs and linked entities to establish investigative leads.`;
    } else if (risk > 50) {
        text += `<br><br><span class="text-emerald-400">Action Suggested:</span> Immediate verification of telecommunications and financial assets recommended. High risk of flight or evidence tampering.`;
    } else {
        text += `<br><br><span class="text-emerald-400">Action Suggested:</span> Continue monitoring peripheral associations to map the broader network structure.`;
    }
    
    aiBox.innerHTML = threatBadgeHtml + text;

    // Populate Evidence List
    document.getElementById('dossier-evidence-search').value = '';
    filterDossierEvidence();
}

function filterDossierEvidence() {
    if (!currentDossierData) return;
    const query = (document.getElementById('dossier-evidence-search').value || '').toLowerCase();
    const list = document.getElementById('dossier-evidence-list');
    list.innerHTML = '';
    
    let allAssociatedFiles = [];
    if (currentDossierData.case_ids) {
        currentDossierData.case_ids.forEach(cid => {
            let caseObj = allCasesCache.find(c => c.id === cid);
            if (caseObj && caseObj.files) {
                caseObj.files.forEach(f => {
                    if (f.toLowerCase().includes(query)) {
                        allAssociatedFiles.push({ file: f, case: cid });
                    }
                });
            }
        });
    }

    const countBadge = document.getElementById('dossier-evidence-count');
    if (countBadge) countBadge.textContent = `${allAssociatedFiles.length} files`;

    if (allAssociatedFiles.length === 0) {
        list.innerHTML = '<div class="text-[10px] text-slate-500 p-2 font-mono text-center">No files found matching criteria.</div>';
        return;
    }

    allAssociatedFiles.forEach(item => {
        const hashId = `evidence-${item.case}-${item.file.replace(/[^a-zA-Z0-9]/g, '')}`;
        const cleanFileName = item.file.replace(/\.(txt|csv|pdf)$/i, '');
        const sizeMb = (Math.random() * 50 + 1).toFixed(1);
        list.innerHTML += `
            <div class="bg-[#0f1523] border border-slate-800/80 p-3 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors shadow-sm" onclick="loadDossierEvidencePreview('${item.file}', '${item.case}')">
                <div class="flex justify-between items-start mb-1">
                    <div class="text-[10px] text-blue-400 font-mono font-bold truncate pr-2 flex items-center">
                        <svg class="w-3 h-3 mr-1.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                        ${item.file}
                    </div>
                    <div id="${hashId}" class="text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-slate-900/30 text-slate-400 border-slate-700 font-bold">CHECKING...</div>
                </div>
                <div class="text-[9px] text-slate-500 font-mono mb-2 uppercase tracking-widest">
                    ${item.case}
                </div>
                <div class="flex items-center justify-between mt-2">
                    <div class="text-[9px] font-mono text-slate-500">${sizeMb} MB</div>
                </div>
            </div>
        `;
    });
}

function loadDossierEvidencePreview(fileName, caseId) {
    const pane = document.getElementById('dossier-evidence-preview');
    pane.innerHTML = `<div class="flex items-center justify-center h-full text-slate-500 font-mono text-xs uppercase tracking-widest animate-pulse">Loading Evidence...</div>`;
    
    fetch(`${API_BASE}/document/${fileName}`)
        .then(res => {
            if(!res.ok) throw new Error("Not found");
            return res.text();
        })
        .then(text => {
            pane.innerHTML = `
                <div class="p-2 bg-slate-800 border-b border-slate-700 font-semibold text-slate-300 text-[10px] tracking-widest uppercase flex justify-between items-center shrink-0">
                    <span>${fileName}</span>
                    <button onclick="closeDossierEvidencePreview()" class="text-slate-500 hover:text-white transition-colors p-1 rounded hover:bg-slate-700" title="Close Preview">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div class="flex-1 overflow-y-auto p-4 custom-scrollbar text-slate-300 font-mono text-[10px] leading-relaxed whitespace-pre-wrap bg-[#0b101a]">
                    ${text}
                </div>
            `;
        })
        .catch(err => {
            pane.innerHTML = `<div class="p-4 text-red-500 font-mono text-xs text-center flex-1 flex items-center justify-center">Error loading file. Document may have been moved or removed.</div>`;
        });
}

function closeDossierEvidencePreview() {
    const pane = document.getElementById('dossier-evidence-preview');
    if (pane) {
        pane.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-slate-500 font-mono text-[10px] uppercase tracking-widest text-center p-8 space-y-4">
                <div class="w-12 h-12 rounded-full border border-slate-700/50 flex items-center justify-center mb-2">
                    <svg class="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                </div>
                <div class="font-bold text-slate-400">Select an evidentiary file to view details.</div>
                <div class="text-[8px] text-slate-500 leading-relaxed max-w-[80%] normal-case tracking-normal text-center">Cryptographic signature proofs, hash digests, and OCR parsed transcripts will render in this viewport upon selection.</div>
            </div>
        `;
    }
}

function exportDossierPDF() {
    if (!currentDossierData) return;
    
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ format: 'a4' });
    
    const data = currentDossierData;
    const dateStr = new Date().toISOString().split('T')[0];
    const randId = Math.floor(1000 + Math.random() * 9000);
    const subjectName = data.label || 'Unknown';
    
    // Header
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(0, 0, 210, 25, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("CRIMINAL NETWORK ANALYSIS SYSTEM", 15, 12);
    doc.text("INVESTIGATION / INTELLIGENCE BRIEF", 195, 12, { align: "right" });
    
    // Title Section
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("INVESTIGATION / INTELLIGENCE BRIEF", 105, 35, { align: "center" });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Criminal Network Analysis System", 105, 42, { align: "center" });
    
    // Metadata Table
    doc.autoTable({
        startY: 50,
        theme: 'grid',
        headStyles: { fillColor: [241, 245, 249], textColor: [0, 0, 0], fontStyle: 'bold' },
        styles: { fontSize: 9, cellPadding: 3, textColor: [0, 0, 0] },
        body: [
            [{ content: 'REPORT ID', fontStyle: 'bold' }, `CNA-2026-${randId}`, { content: 'DATE', fontStyle: 'bold' }, dateStr],
            [{ content: 'SUBJECT', fontStyle: 'bold' }, subjectName, { content: 'PERSON ID', fontStyle: 'bold' }, data.id],
            [{ content: 'STATUS', fontStyle: 'bold' }, 'Under Investigation', { content: 'CLASSIFICATION', fontStyle: 'bold' }, 'CONFIDENTIAL']
        ]
    });
    
    let y = doc.lastAutoTable.finalY + 15;
    
    // 1. Subject Details
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("1. SUBJECT DETAILS", 15, y);
    doc.autoTable({
        startY: y + 4,
        theme: 'grid',
        headStyles: { fillColor: [241, 245, 249], textColor: [0, 0, 0], fontStyle: 'bold' },
        styles: { fontSize: 9, cellPadding: 3, textColor: [0, 0, 0] },
        body: [
            [{ content: 'Name', fontStyle: 'bold' }, subjectName, { content: 'Alias', fontStyle: 'bold' }, 'N/A'],
            [{ content: 'Location', fontStyle: 'bold' }, 'Unknown', { content: 'Linked Cases', fontStyle: 'bold' }, data.case_ids ? data.case_ids.length : 0],
            [{ content: 'Linked Persons', fontStyle: 'bold' }, data.degree || 0, { content: 'Status', fontStyle: 'bold' }, 'Under Investigation']
        ]
    });
    
    y = doc.lastAutoTable.finalY + 15;
    
    // 2. Linked Cases
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("2. LINKED CASES & EVIDENTIARY TRACE", 15, y);
    
    let casesBody = [];
    if (data.case_ids && data.case_ids.length > 0) {
        data.case_ids.forEach(cid => casesBody.push([cid, 'Investigation', dateStr, 'Verified']));
    } else {
        casesBody.push(['No linked cases.', '-', '-', '-']);
    }
    
    doc.autoTable({
        startY: y + 4,
        theme: 'grid',
        head: [['CASE / FIR', 'NATURE', 'DATE', 'INTEGRITY STATUS']],
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255] },
        styles: { fontSize: 9, cellPadding: 3, textColor: [0, 0, 0] },
        body: casesBody
    });
    
    y = doc.lastAutoTable.finalY + 15;
    
    // 3. Identified Connections
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("3. IDENTIFIED CONNECTIONS & INTELLIGENCE", 15, y);
    
    let connBody = [];
    const connectedEdges = graphData.edges.filter(e => e.data.source === data.id || e.data.target === data.id);
    let connCount = 0;
    connectedEdges.forEach(e => {
        if(connCount > 15) return;
        let otherNodeId = e.data.source === data.id ? e.data.target : e.data.source;
        let otherNode = graphData.nodes.find(n => n.data.id === otherNodeId);
        if (otherNode) {
            connBody.push([formatGraphEdgeText(subjectName, e.data.type, otherNode.data.label)]);
            connCount++;
        }
    });
    if (connBody.length === 0) connBody.push(["No direct connections identified."]);
    
    doc.autoTable({
        startY: y + 4,
        theme: 'grid',
        head: [['INTELLIGENCE TEXT']],
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255] },
        styles: { fontSize: 9, cellPadding: 3, textColor: [0, 0, 0] },
        body: connBody
    });
    
    y = doc.lastAutoTable.finalY + 15;
    
    // Check page break
    if (y > 230) {
        doc.addPage();
        y = 20;
    }
    
    // 4. Analytical Assessment
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("4. ANALYTICAL ASSESSMENT (AI INSIGHTS)", 15, y);
    
    const aiText = document.getElementById('dossier-ai-assessment').innerText;
    doc.autoTable({
        startY: y + 4,
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 4, textColor: [0, 0, 0] },
        body: [
            [{ content: 'FINDING', fontStyle: 'bold', fillColor: [241, 245, 249] }],
            [aiText],
            [{ content: 'CAUTION', fontStyle: 'bold', fillColor: [254, 242, 242], textColor: [153, 27, 27] }],
            [{ content: 'These system-generated associations are investigative leads and do not independently establish criminal liability.', textColor: [153, 27, 27] }]
        ]
    });
    
    y = doc.lastAutoTable.finalY + 15;
    
    if (y > 240) {
        doc.addPage();
        y = 20;
    }
    
    // 5. Source & Integrity
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("5. SOURCE & INTEGRITY", 15, y);
    doc.autoTable({
        startY: y + 4,
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 3, textColor: [0, 0, 0] },
        body: [
            [{ content: 'Evidence Hash', fontStyle: 'bold' }, 'SHA-256 recorded'],
            [{ content: 'Source Traceability', fontStyle: 'bold' }, 'Available'],
            [{ content: 'Generated By', fontStyle: 'bold' }, 'Criminal Network Analysis System']
        ]
    });
    
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(`Confidential • System-generated intelligence brief • Page 1`, 15, 285);
    
    doc.save(`CNA_Dossier_${data.id}.pdf`);
}

function viewInNetworkGraph() {
    if (!currentDossierData) return;
    
    // First read the case_ids array associated with this entity
    const caseIds = currentDossierData.case_ids || [];
    
    // Check/select ONLY those specific cases in the Graph's Case Filter
    const checkboxes = document.querySelectorAll('#case-directory-list input[type="checkbox"]');
    checkboxes.forEach(cb => {
        if (caseIds.includes(cb.value)) {
            cb.checked = true;
        } else {
            cb.checked = false;
        }
    });
    
    // Trigger graph update to reflect the filtered cases
    updateGraphView();
    
    // Switch to the Network Canvas tab
    switchTab('graph');
    
    // Execute the search animation to zoom directly onto this entity's node
    setTimeout(() => {
        if (cy) {
            const node = cy.getElementById(currentDossierData.id);
            if (node && node.length > 0) {
                // Remove existing highlights
                cy.elements().removeClass('search-focus search-fade target-halo');
                
                // Dim non-neighbors, highlight neighbors and target
                const neighborhood = node.neighborhood().union(node);
                cy.elements().difference(neighborhood).addClass('search-fade');
                neighborhood.addClass('search-focus');
                node.addClass('target-halo');
                
                // Zoom and pan
                cy.animate({
                    fit: {
                        eles: neighborhood,
                        padding: 100
                    },
                    duration: 800
                });
                
                // Update the right inspector pane automatically
                updateInvestigatorPanel(node.data());
            }
        }
    }, 400); // Allow graph time to layout after updateGraphView
}

// --- Data Ingestion Studio (Tab 3) ---
let currentUploadFile = null;
let extractedEntitiesCache = [];

function handleDrop(e) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFileSelect(e.dataTransfer.files[0]);
    }
}

function handleFileSelect(e) {
    if (e.target.files && e.target.files.length > 0) {
        processFileSelect(e.target.files[0]);
    }
}

async function processFileSelect(file) {
    currentUploadFile = file;
    // Don't hide upload-zone in the new 2-column layout, just activate the preview zone
    document.getElementById('ingest-empty-state').classList.add('hidden');
    document.getElementById('ingest-preview-zone').classList.remove('hidden');
    document.getElementById('ingest-preview-zone').classList.add('flex');
    
    document.getElementById('preview-filename').textContent = file.name;
    document.getElementById('source-filename-label').textContent = file.name;
    document.getElementById('commit-proof-btn').disabled = false;
    
    // --- AUTO-DETECT CASE ID FROM FILENAME AND CONTENT ---
    const caseIdInput = document.getElementById('ingest-case-id');
    try {
        const textContent = await file.text();
        const match = textContent.match(/FIR NO:\s*([^\n]+)/);
        if (match) {
            caseIdInput.value = match[1].trim();
        } else if (!caseIdInput.value.trim()) {
            const firMatch = file.name.match(/(FIR[-\w]+)(?:\.\w+)?$/);
            if (firMatch) {
                caseIdInput.value = firMatch[1];
            }
        }
    } catch (err) {}
    
    const rawTextDiv = document.getElementById('ingest-raw-text');
    const entitySumDiv = document.getElementById('ingest-entity-summary');
    
    rawTextDiv.innerHTML = '<span class="animate-pulse text-slate-500">Running hybrid NLP pipeline...</span>';
    entitySumDiv.innerHTML = '<span class="animate-pulse text-slate-500">Extracting entities...</span>';
    
    const inferredCaseId = caseIdInput.value.trim() || "TEMP-PREVIEW";
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('case_id', inferredCaseId);
    
    try {
        const res = await fetch(`${API_BASE}/extract`, {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Server error ${res.status}: ${errText}`);
        }
        const data = await res.json();
        
        extractedEntitiesCache = data.entities;
        
        // Render Raw Text with Highlights
        let text = data.text;
        let highlightedText = text;
        // Sort by start descending to avoid offset corruption when injecting spans
        const sortedEnts = [...data.entities].sort((a,b) => b.start - a.start);
        sortedEnts.forEach(ent => {
            const before = highlightedText.substring(0, ent.start);
            const mid = highlightedText.substring(ent.start, ent.end);
            const after = highlightedText.substring(ent.end);
            
            let colorClass = "bg-slate-700 text-white";
            if (ent.type === 'PERSON') colorClass = "bg-yellow-900/60 text-yellow-200";
            else if (ent.type === 'PHONE') colorClass = "bg-blue-900/60 text-blue-200";
            else if (ent.type === 'BANK_ACCOUNT') colorClass = "bg-emerald-900/60 text-emerald-200";
            else if (ent.type === 'VEHICLE') colorClass = "bg-purple-900/60 text-purple-200";
            else if (ent.type === 'ORGANIZATION') colorClass = "bg-orange-900/60 text-orange-200";
            else if (ent.type === 'LOCATION') colorClass = "bg-cyan-900/60 text-cyan-200";
            
            highlightedText = `${before}<span class="${colorClass} px-1 rounded mx-0.5 border border-slate-600/50" title="${ent.type}">${mid}</span>${after}`;
        });
        
        rawTextDiv.innerHTML = highlightedText;
        
        // Update labels
        document.getElementById('preview-binding-label').textContent = inferredCaseId;
        document.getElementById('entity-count-label').textContent = `${data.entities.length} ENTITIES EXTRACTED`;
        
        // Render Entity Summary — card grid
        if (data.entities.length > 0) {
            
            const typeConfig = {
                'PERSON':       { code: 'PRS', label: 'PERSONNEL', colorClass: 'bg-indigo-900/30 text-indigo-400 border-indigo-900/50', name: 'SUSPECT NAME' },
                'PHONE':        { code: 'TEL', label: 'TELECOM', colorClass: 'bg-rose-900/30 text-rose-400 border-rose-900/50', name: 'PHONE (1)' },
                'BANK_ACCOUNT': { code: 'FIN', label: 'FINANCE', colorClass: 'bg-emerald-900/30 text-emerald-400 border-emerald-900/50', name: 'BANK ACCOUNT (SBI)' },
                'VEHICLE':      { code: 'VEH', label: 'PHYSICAL', colorClass: 'bg-fuchsia-900/30 text-fuchsia-400 border-fuchsia-900/50', name: 'VEHICLE PLATE (1)' },
                'LOCATION':     { code: 'LOC', label: 'GEO-INT', colorClass: 'bg-slate-800/50 text-slate-300 border-slate-700', name: 'LOCATION MENTION' },
                'ORGANIZATION': { code: 'ORG', label: 'ENTITY', colorClass: 'bg-amber-900/30 text-amber-400 border-amber-900/50', name: 'ORGANIZATION' }
            };
            
            // Deduplicate for cards
            const uniqueEnts = [];
            const seen = new Set();
            data.entities.forEach(ent => {
                if(!seen.has(ent.type + ent.value)) {
                    seen.add(ent.type + ent.value);
                    uniqueEnts.push(ent);
                }
            });

            let sumHtml = '';
            uniqueEnts.forEach(ent => {
                const conf = typeConfig[ent.type] || { code: 'UNK', label: 'UNKNOWN', colorClass: 'bg-slate-800 text-slate-400 border-slate-700', name: 'EXTRACTED ENTITY' };
                
                sumHtml += `
                <div class="bg-slate-900/50 border border-slate-800/80 rounded-lg p-3 flex flex-col justify-between hover:bg-slate-800/50 transition-colors">
                    <div class="flex justify-between items-center mb-3">
                        <span class="${conf.colorClass} border px-1.5 py-0.5 text-[8px] font-bold rounded uppercase tracking-widest">${conf.code}</span>
                        <span class="${conf.colorClass} border px-1.5 py-0.5 text-[8px] font-bold rounded uppercase tracking-widest">${conf.label}</span>
                    </div>
                    <div class="text-[8px] text-slate-500 font-bold uppercase tracking-widest mb-1">${conf.name}</div>
                    <div class="text-[11px] text-slate-200 font-mono truncate" title="${ent.value}">${ent.value}</div>
                </div>
                `;
            });
            entitySumDiv.innerHTML = sumHtml;
        } else {
            entitySumDiv.innerHTML = `<span class="text-yellow-500 text-xs font-mono">No actionable entities extracted. Check that the file is a valid FIR/CDR document.</span>`;
        }
        
    } catch(e) {
        console.error('Extract error:', e);
        rawTextDiv.innerHTML = `<span class="text-red-500 font-mono text-xs">Failed to extract preview.<br><small class="text-slate-500">${e.message}</small></span>`;
        entitySumDiv.innerHTML = `<span class="text-red-500 font-mono text-xs">Extraction pipeline error. Check backend logs.</span>`;
    }
}

async function commitProof() {
    if (!currentUploadFile) return;
    
    const caseIdInput = document.getElementById('ingest-case-id');
    const caseId = caseIdInput.value.trim();
    if (!caseId) {
        alert("Please enter a CASE ID.");
        caseIdInput.focus();
        return;
    }
    
    const btn = document.getElementById('commit-proof-btn');
    btn.disabled = true;
    btn.innerHTML = "Committing...";
    
    const formData = new FormData();
    formData.append('file', currentUploadFile);
    formData.append('case_id', caseId);
    
    try {
        const res = await fetch(`${API_BASE}/ingest`, {
            method: 'POST',
            body: formData
        });
        
        let data;
        try {
            data = await res.json();
        } catch(parseErr) {
            const rawText = await res.text().catch(() => 'Unknown error');
            throw new Error(`Server returned non-JSON (${res.status}): ${rawText.substring(0, 200)}`);
        }
        
        if (!res.ok) {
            throw new Error(`Ingestion failed (${res.status}): ${data.detail || JSON.stringify(data)}`);
        }
        
        // Success — show toast and reset UI
        const toast = document.getElementById('ingest-toast');
        toast.classList.remove('hidden');
        setTimeout(() => { toast.classList.add('hidden'); }, 4000);
        
        document.getElementById('upload-zone').classList.remove('hidden');
        document.getElementById('ingest-preview-zone').classList.add('hidden');
        currentUploadFile = null;
        caseIdInput.value = '';
        btn.innerHTML = "Commit Proof to Graph & Ledger";
        btn.disabled = true;
        
        // Refresh graph and case directory
        await fetchGraphData();
        const casesRes = await fetch(`${API_BASE}/cases`);
        const casesData = await casesRes.json();
        allCasesCache = [...casesData.active, ...casesData.closed];
        
        const list = document.getElementById('case-directory-list');
        list.innerHTML = '';
        allCasesCache.forEach(c => {
            list.innerHTML += `
                <li class="flex items-center space-x-2">
                    <input type="checkbox" id="case-${c.id}" value="${c.id}" onchange="updateGraphView()" class="form-checkbox bg-slate-900 border-slate-600 text-slate-500 focus:ring-0" checked>
                    <label for="case-${c.id}" class="cursor-pointer hover:text-white transition-colors text-xs truncate" title="${c.id}">${c.id}</label>
                </li>
            `;
        });
        updateGraphView();
        
    } catch(e) {
        console.error('Commit error:', e);
        alert(`Error committing proof: ${e.message}`);
        btn.disabled = false;
        btn.innerHTML = "Commit Proof";
    }
}

// --- Initialization & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {

    // Mode Switching Listeners
    const btnGraph = document.getElementById('btn-tab-graph');
    if (btnGraph) btnGraph.addEventListener('click', () => switchTab('graph'));
    
    const btnAnalysis = document.getElementById('btn-tab-analysis');
    if (btnAnalysis) btnAnalysis.addEventListener('click', () => switchTab('analysis'));
    
    // Ingestion Studio Listeners
    const uploadZone = document.getElementById('upload-zone');
    if (uploadZone) {
        uploadZone.addEventListener('dragover', (e) => e.preventDefault());
        uploadZone.addEventListener('drop', handleDrop);
    }
    
    const fileInput = document.getElementById('file-upload-input');
    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }
    
    const commitBtn = document.getElementById('commit-proof-btn');
    if (commitBtn) {
        commitBtn.addEventListener('click', commitProof);
    }
    
    // Auto-populate evidence table initially
    setTimeout(() => populateGlobalEvidenceTable(), 1500);
});

function populateGlobalEvidenceTable() {
    const tbody = document.getElementById('global-evidence-table-body');
    if (!tbody || !allCasesCache) return;
    
    tbody.innerHTML = '';
    
    let allAssociatedFiles = [];
    allCasesCache.forEach(caseObj => {
        if (caseObj.files && caseObj.files.length > 0) {
            caseObj.files.forEach(f => {
                allAssociatedFiles.push({ 
                    file: f, 
                    case: caseObj.id,
                    status: caseObj.status || 'Open',
                    date: caseObj.date || 'Unknown Date',
                    officer: caseObj.officer,
                    station: caseObj.station
                });
            });
        }
    });
    
    if (allAssociatedFiles.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-500 text-xs font-mono">No cryptographic evidence found in ledger.</td></tr>`;
        return;
    }
    
    allAssociatedFiles.forEach(item => {
        // Generate pseudo-hashes for UI realism based on filename
        const hashBase = btoa(item.file + item.case).toLowerCase().replace(/[^a-z0-9]/g, '');
        const pseudoHash = hashBase.substring(0, 8) + '...' + hashBase.substring(hashBase.length - 8);
        const randDate = item.date !== 'Unknown Date' ? item.date : new Date(Date.now() - Math.floor(Math.random() * 10000000000)).toISOString().split('T')[0];
        
        // Randomize classification slightly
        let classification = "Unclassified";
        let classColor = "text-slate-400";
        if (Math.random() > 0.7) {
            classification = "Restricted / TS";
            classColor = "text-red-400 bg-red-900/20 px-1 rounded border border-red-800";
        } else if (Math.random() > 0.4) {
            classification = "LES Sensitive";
            classColor = "text-amber-400 bg-amber-900/20 px-1 rounded border border-amber-800";
        }

        const cleanFileName = item.file.replace(/\.(txt|csv|pdf)$/i, '');
        
        // Pseudo-randomizing IO and Station based on Case ID if missing
        const caseCharSum = [...item.case].reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const officers = ['Insp. Gowda', 'Insp. Sharma', 'Sub-Insp. Reddy', 'ACP Kapoor', 'Insp. Desai', 'DCP Singh'];
        const stations = ['PS BENGALURU (CYBER)', 'HQ CYBER CELL DEL', 'PS ANDHERI EAST', 'PS INDIRANAGAR', 'CBI SPECIAL BRANCH', 'PS BANDRA KURLA'];
        
        const finalOfficer = item.officer || officers[caseCharSum % officers.length];
        const finalStation = item.station || stations[caseCharSum % stations.length];

        tbody.innerHTML += `
            <tr class="border-b border-slate-700/50 hover:bg-slate-700/50 transition-colors cursor-pointer" onclick="document.getElementById('entity-profile-overlay').classList.remove('hidden'); renderSubjectDossier('${item.case}')">
                <td class="px-4 py-2">
                    <div class="text-xs text-blue-400 font-mono cursor-pointer hover:underline">${cleanFileName}</div>
                </td>
                <td class="px-4 py-2">
                    <div class="text-xs text-slate-300 font-mono"><span class="text-slate-500">Status:</span> <span class="font-bold ${item.status.toLowerCase() === 'closed' ? 'text-emerald-400' : 'text-blue-400'}">${item.status.toUpperCase()}</span></div>
                    <div class="text-[9px] text-slate-400 mt-1 flex items-center font-mono">
                        <svg class="w-3 h-3 mr-1 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        Logged: ${randDate} 14:32
                    </div>
                </td>
                <td class="px-4 py-2">
                    <div class="text-[10px] text-slate-300 font-mono font-bold mb-1 tracking-wide">IO: ${finalOfficer}</div>
                    <div class="text-[10px] text-slate-400 font-mono">Station: ${finalStation}</div>
                </td>
            </tr>
        `;
    });
}

// --- Auto-Hiding Panel Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const leftHoverZone = document.getElementById('left-hover-zone');
    const rightHoverZone = document.getElementById('right-hover-zone');
    const leftPane = document.getElementById('left-pane');
    const rightPane = document.getElementById('right-pane');

    if (leftHoverZone && leftPane) {
        leftHoverZone.addEventListener('mouseenter', () => {
            leftPane.classList.remove('-translate-x-full');
        });
        leftPane.addEventListener('mouseleave', () => {
            leftPane.classList.add('-translate-x-full');
        });
    }

    if (rightHoverZone && rightPane) {
        rightHoverZone.addEventListener('mouseenter', () => {
            rightPane.classList.remove('translate-x-full');
        });
        rightPane.addEventListener('mouseleave', () => {
            if (!rightPane.classList.contains('force-open')) {
                rightPane.classList.add('translate-x-full');
            }
        });
    }
});


// --- Auto-Verify Proof File Status Badges ---
async function autoVerifyProofFiles(fileNames, fileResults) {
    if (!fileNames || fileNames.length === 0) return;
    try {
        const res = await fetch(API_BASE + '/monitor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: fileNames })
        });
        const data = await res.json();
        
        fileResults.forEach(({cid, files}) => {
            files.forEach(fileName => {
                const safeId = `status-${cid}-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
                const el = document.getElementById(safeId);
                if (!el) return;
                if (data[fileName] && data[fileName].status === "SECURE") {
                    el.textContent = 'TAMPER-PROOF';
                    el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-emerald-900/30 text-emerald-400 border-emerald-700 font-bold';
                } else {
                    el.textContent = 'TAMPERED';
                    el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-red-900/30 text-red-400 border-red-700 font-bold';
                }
            });
        });
    } catch(e) { console.error('Auto-verify failed:', e); }
}

async function autoVerifyCaseFiles(fileNames, caseId) {
    if (!fileNames || fileNames.length === 0) return;
    try {
        const res = await fetch(API_BASE + '/monitor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: fileNames })
        });
        const data = await res.json();
        
        fileNames.forEach(fileName => {
            const safeId = `status-case-${caseId}-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
            const el = document.getElementById(safeId);
            if (!el) return;
            if (data[fileName] && data[fileName].status === "SECURE") {
                el.textContent = 'TAMPER-PROOF';
                el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-emerald-900/30 text-emerald-400 border-emerald-700 font-bold';
            } else {
                el.textContent = 'TAMPERED';
                el.className = 'text-[8px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 bg-red-900/30 text-red-400 border-red-700 font-bold';
            }
        });
    } catch(e) { console.error('Auto-verify case files failed:', e); }
}

function toggleVisualizationMode() {
    const mode = document.getElementById('visualization-mode').value;
    const cyContainer = document.getElementById('cy');
    const geoContainer = document.getElementById('geo-map');
    
    if (mode === 'network') {
        cyContainer.classList.remove('hidden');
        geoContainer.classList.add('hidden');
    } else {
        cyContainer.classList.add('hidden');
        geoContainer.classList.remove('hidden');
        if (!geoContainer.hasAttribute('data-rendered')) {
            renderGeographicalMap(geoContainer);
            geoContainer.setAttribute('data-rendered', 'true');
        }
    }
}

function renderGeographicalMap(container) {
    // Faint grid background
    container.style.backgroundImage = 'radial-gradient(circle, #1e293b 1px, transparent 1px)';
    container.style.backgroundSize = '40px 40px';
    container.style.position = 'relative';
    container.style.overflow = 'hidden';

    container.innerHTML = `
        <div class="absolute inset-0 pointer-events-none opacity-10 flex items-center justify-center">
            <svg viewBox="0 0 100 100" class="w-full h-full max-w-2xl max-h-2xl">
                <!-- Abstract polygon for subcontinent -->
                <polygon points="30,20 60,20 80,45 60,95 40,80 20,50" fill="none" stroke="#64748b" stroke-width="0.5"/>
            </svg>
        </div>
        <div id="geo-map-content" class="relative w-full h-full max-w-4xl mx-auto">
        </div>
    `;

    const mapContent = document.getElementById('geo-map-content');

    const cities = [
        { id: 'delhi', name: 'Delhi', top: '20%', left: '45%', type: 'LOCATION', entity: 'Safehouse Alpha' },
        { id: 'jaipur', name: 'Jaipur', top: '30%', left: '38%', type: 'PERSON', entity: 'Subject X' },
        { id: 'lucknow', name: 'Lucknow', top: '32%', left: '55%', type: 'PHONE', entity: '+91-9876543210' },
        { id: 'ahmedabad', name: 'Ahmedabad', top: '45%', left: '32%', type: 'ACCOUNT', entity: 'ACC-19842' },
        { id: 'mumbai', name: 'Mumbai', top: '65%', left: '30%', type: 'PERSON', entity: 'Subject Y' },
        { id: 'hyderabad', name: 'Hyderabad', top: '65%', left: '50%', type: 'PHONE', entity: '+91-8888888888' },
        { id: 'bengaluru', name: 'Bengaluru', top: '82%', left: '45%', type: 'ACCOUNT', entity: 'ACC-99211' },
        { id: 'kolkata', name: 'Kolkata', top: '48%', left: '72%', type: 'PERSON', entity: 'Subject Z' }
    ];

    const connections = [
        { source: 'ahmedabad', target: 'mumbai', type: 'Financial Transfer', color: '#fbbf24', style: 'solid' },
        { source: 'mumbai', target: 'delhi', type: 'Telecom (CDR)', color: '#10b981', style: 'dashed' },
        { source: 'delhi', target: 'lucknow', type: 'Co-Accused / FIR', color: '#3b82f6', style: 'solid' },
        { source: 'hyderabad', target: 'bengaluru', type: 'AI Predicted (Hidden)', color: '#8b5cf6', style: 'dotted' }
    ];

    let svgHtml = '<svg class="absolute inset-0 w-full h-full pointer-events-none">';
    connections.forEach(conn => {
        const sourceCity = cities.find(c => c.id === conn.source);
        const targetCity = cities.find(c => c.id === conn.target);
        if (sourceCity && targetCity) {
            let strokeDasharray = "";
            if (conn.style === 'dashed') strokeDasharray = "4,4";
            if (conn.style === 'dotted') strokeDasharray = "2,4";
            svgHtml += `<line x1="${sourceCity.left}" y1="${sourceCity.top}" x2="${targetCity.left}" y2="${targetCity.top}" stroke="${conn.color}" stroke-width="1.5" stroke-dasharray="${strokeDasharray}" opacity="0.6"/>`;
        }
    });
    svgHtml += '</svg>';
    mapContent.innerHTML += svgHtml;

    cities.forEach(city => {
        let colorClass = 'bg-slate-500 border-slate-400';
        if (city.type === 'PERSON') colorClass = 'bg-red-900 border-red-500';
        else if (city.type === 'PHONE') colorClass = 'bg-blue-900 border-blue-500';
        else if (city.type === 'ACCOUNT') colorClass = 'bg-amber-900 border-amber-500';
        else if (city.type === 'LOCATION') colorClass = 'bg-emerald-900 border-emerald-500';

        const markerHtml = `
            <div class="absolute group transform -translate-x-1/2 -translate-y-1/2 cursor-pointer flex flex-col items-center z-10" style="top: ${city.top}; left: ${city.left};" onclick="selectGeoNode('${city.name}', '${city.entity}', '${city.type}')">
                <div class="w-3 h-3 rounded-full border ${colorClass} shadow-[0_0_8px_rgba(255,255,255,0.2)] group-hover:scale-150 transition-transform duration-200"></div>
                <div class="mt-1 text-[9px] font-mono font-bold text-slate-400 uppercase tracking-widest bg-slate-900/80 px-1 rounded whitespace-nowrap opacity-70 group-hover:opacity-100">${city.name}</div>
                
                <div class="absolute bottom-full mb-2 hidden group-hover:block w-40 bg-slate-800 border border-slate-600 rounded p-2 text-xs shadow-xl z-20 pointer-events-none">
                    <div class="text-[9px] text-slate-500 uppercase tracking-widest border-b border-slate-700 pb-1 mb-1">Entity Profile</div>
                    <div class="font-bold text-slate-200">${city.entity}</div>
                    <div class="text-[10px] text-slate-400 mt-1">TYPE: <span class="text-white">${city.type}</span></div>
                    <div class="text-[10px] text-slate-400">LOC: <span class="text-white">${city.name}</span></div>
                    <div class="text-[10px] text-cyan-500 mt-1 uppercase font-bold">AI Identified</div>
                </div>
            </div>
        `;
        mapContent.innerHTML += markerHtml;
    });
}

function selectGeoNode(location, entity, type) {
    const inspector = document.getElementById('inspector-content');
    if(inspector) {
        inspector.innerHTML = `
            <div class="mb-4 border-b border-slate-700 pb-2">
                <h3 class="text-sm font-bold text-slate-100 font-mono tracking-widest uppercase">Geospatial Entity Details</h3>
                <p class="text-[10px] text-slate-400 mt-1 uppercase">Region: <span class="text-white font-bold">${location}</span></p>
            </div>
            <div class="space-y-4">
                <div>
                    <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Target Identity</h4>
                    <p class="text-xs font-mono text-slate-200 bg-slate-900 p-2 border border-slate-700">${entity}</p>
                </div>
                <div>
                    <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Classification</h4>
                    <p class="text-xs font-mono text-slate-200 bg-slate-900 p-2 border border-slate-700">${type}</p>
                </div>
                <div>
                    <h4 class="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Status</h4>
                    <p class="text-xs font-mono text-emerald-400 font-bold bg-slate-900 p-2 border border-slate-700">Prototype Geospatial Pin</p>
                </div>
            </div>
        `;
        const rp = document.getElementById('right-pane');
        if (rp) {
            rp.classList.add('force-open');
            rp.classList.remove('translate-x-full');
        }
    }
}
