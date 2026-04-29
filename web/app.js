(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  };

  const cache = {
    index: null,
    factions: new Map(), // faction_id → bundle
    search: null,
    rules: null,
    keywords: null,
    kwIndex: null,       // { re, bySlug, byLower } built from keywords
  };

  async function loadIndex() {
    if (cache.index) return cache.index;
    cache.index = await (await fetch('data/index.json')).json();
    return cache.index;
  }
  async function loadFaction(id) {
    if (cache.factions.has(id)) return cache.factions.get(id);
    const b = await (await fetch(`data/factions/${id}.json`)).json();
    cache.factions.set(id, b);
    return b;
  }
  async function loadSearch() {
    if (cache.search) return cache.search;
    cache.search = await (await fetch('data/search.json')).json();
    return cache.search;
  }
  async function loadRules() {
    if (cache.rules) return cache.rules;
    const r = await fetch('data/rules.json');
    cache.rules = r.ok ? await r.json() : { sections: [] };
    return cache.rules;
  }
  async function loadKeywords() {
    if (cache.keywords) return cache.keywords;
    const r = await fetch('data/keywords.json');
    cache.keywords = r.ok ? await r.json() : { keywords: [] };
    cache.kwIndex = buildKeywordIndex(cache.keywords.keywords);
    return cache.keywords;
  }

  // ---------------- Keyword linkifier ----------------

  // Build a single big regex with all keyword names sorted longest-first.
  // Multi-word names allow flexible whitespace (e.g. "DEEP\s+STRIKE") so the
  // matcher copes with line-breaks or NBSP. Word boundaries on both sides
  // prevent matching "STRIKE" inside "STRIKEFORCE".
  function buildKeywordIndex(keywords) {
    if (!keywords || !keywords.length) return null;
    const items = keywords.slice().sort((a, b) => b.name.length - a.name.length);
    const bySlug = Object.fromEntries(items.map(k => [k.slug, k]));
    const byLower = new Map(items.map(k => [k.name.toLowerCase(), k.slug]));
    const escaped = items.map(k =>
      k.name
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+')
    );
    const re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
    return { re, bySlug, byLower };
  }

  // Walk text nodes inside `root` and turn keyword matches into anchor links.
  // Skips text already inside <a> elements so we never double-link.
  function linkifyKeywords(root) {
    const idx = cache.kwIndex;
    if (!idx || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== root) {
          if (p.nodeName === 'A') return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const text = node.textContent;
      idx.re.lastIndex = 0;
      if (!idx.re.test(text)) continue;
      idx.re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = idx.re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const slug = idx.byLower.get(m[0].toLowerCase().replace(/\s+/g, ' '));
        if (slug) {
          const a = document.createElement('a');
          a.href = `#/keyword/${slug}`;
          a.className = 'kw-link';
          a.textContent = m[0];
          frag.appendChild(a);
        } else {
          frag.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // ---------------- Rules HTML renderer ----------------

  const BLOCK = new Set(['p', 'div', 'tr', 'table', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4']);
  function renderRulesHTML(html) {
    const out = document.createElement('div');
    if (!html) return out;
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    walkNode(doc.body.firstChild, out, {});
    linkifyKeywords(out);
    return out;
  }
  function walkNode(node, parent, ctx) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (!child.textContent) continue;
        const span = document.createElement('span');
        span.textContent = child.textContent;
        if (ctx.bold) span.style.fontWeight = '600';
        if (ctx.kwb) span.className = 'kwb';
        if (ctx.header) { span.style.fontWeight = '600'; span.style.display = 'block'; span.style.marginTop = '8px'; }
        parent.appendChild(span);
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        const cls = child.getAttribute('class') || '';
        if (tag === 'br') { parent.appendChild(document.createElement('br')); continue; }
        const newCtx = { ...ctx };
        if (tag === 'b' || tag === 'strong') newCtx.bold = true;
        if (cls.includes('kwb') && !cls.includes('kwbu')) newCtx.kwb = true;
        if (cls.includes('impact18') || cls.includes('impact20')) newCtx.header = true;
        if (cls.includes('kwbu')) newCtx.bold = true;
        const block = BLOCK.has(tag) || cls.includes('BreakInsideAvoid');
        if (block && parent.childNodes.length && parent.lastChild.nodeName !== 'BR') {
          parent.appendChild(document.createElement('br'));
        }
        walkNode(child, parent, newCtx);
        if (block) parent.appendChild(document.createElement('br'));
      }
    }
  }

  // ---------------- Search index helpers ----------------

  function searchHits(type, q, limit = 100) {
    if (!cache.search) return [];
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    for (const r of cache.search) {
      if (r.t !== type) continue;
      if (r.n.toLowerCase().includes(q)) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  function tabSearch({ placeholder, type, makeHref, factionsById }) {
    const input = el('input', { class: 'search-input', placeholder, type: 'search' });
    const results = el('ul', { class: 'list', hidden: '' });
    function render(q) {
      results.replaceChildren();
      const hits = searchHits(type, q);
      if (!q || q.trim().length < 2) {
        results.hidden = true;
        return;
      }
      results.hidden = false;
      if (!hits.length) {
        results.append(el('li', {}, el('div', { class: 'empty' }, 'No matches.')));
        return;
      }
      for (const h of hits) {
        const sub = factionsById && h.f ? (factionsById[h.f] || h.f) : null;
        results.append(el('li', {}, el('a', { href: makeHref(h) }, [
          h.n,
          sub ? el('span', { class: 'sub' }, sub) : null,
        ].filter(Boolean))));
      }
    }
    input.addEventListener('input', e => render(e.target.value));
    return { input, results, isActive: () => !results.hidden };
  }

  // ---------------- Views: Units ----------------

  async function viewUnits() {
    setTitle('Units');
    const idx = await loadIndex();
    await loadSearch();
    const factionsById = Object.fromEntries(idx.factions.map(f => [f.id, f.name]));

    const ts = tabSearch({
      placeholder: 'Search all units…',
      type: 'u',
      makeHref: h => `#/unit/${h.f}/${h.i}`,
      factionsById,
    });

    const factionList = el('ul', { class: 'list' },
      idx.factions.map(f =>
        el('li', {}, el('a', { href: `#/faction/${f.id}` }, f.name))
      )
    );

    // Hide the faction browse when search has results, show it when cleared.
    ts.input.addEventListener('input', () => {
      factionList.hidden = ts.isActive();
    });

    return el('div', {}, [ts.input, ts.results, factionList]);
  }

  async function viewFaction(id) {
    const b = await loadFaction(id);
    setTitle(b.faction.name);
    const search = el('input', { class: 'search-input', placeholder: `Filter ${b.faction.name} units…`, type: 'search' });
    const ul = el('ul', { class: 'list' });
    function render(filter) {
      ul.replaceChildren(...b.datasheets
        .filter(d => !filter || d.name.toLowerCase().includes(filter.toLowerCase()))
        .map(d => el('li', {}, el('a', { href: `#/unit/${id}/${d.id}` }, [
          d.name,
          d.role ? el('span', { class: 'sub' }, d.role) : null,
        ]))));
    }
    render('');
    search.addEventListener('input', e => render(e.target.value));
    return el('div', {}, [search, ul]);
  }

  async function viewUnit(factionId, unitId) {
    const b = await loadFaction(factionId);
    await loadKeywords();
    const ds = b.datasheets.find(d => d.id === unitId);
    if (!ds) return el('div', { class: 'empty' }, 'Unit not found.');
    setTitle(ds.name);

    const out = el('div');
    out.append(el('div', {}, [
      el('h2', {}, ds.name),
      ds.role ? el('div', { class: 'sub', style: 'color:var(--muted);font-size:14px' }, ds.role) : null,
      ds.costs && ds.costs.length
        ? el('div', { style: 'margin-top:6px' },
            ds.costs.map(c => el('span', { class: 'pts' }, `${c.cost} pts — ${c.description}`)))
        : null,
    ].filter(Boolean)));

    if (ds.models && ds.models.length) {
      const card = el('div', { class: 'card' }, el('h3', {}, 'Stats'));
      for (const m of ds.models) {
        if (ds.models.length > 1) card.append(el('h4', {}, m.name));
        const row = el('div', { class: 'stat-row' });
        const stats = [['M', m.M], ['T', m.T], ['Sv', m.Sv]];
        if (m.invSv && m.invSv !== '-') stats.push(['Inv', m.invSv]);
        stats.push(['W', m.W], ['Ld', m.Ld], ['OC', m.OC]);
        for (const [lbl, val] of stats) {
          row.append(el('div', { class: 'stat' }, [
            el('span', { class: 'lbl' }, lbl),
            el('span', { class: 'val' }, val ?? '—'),
          ]));
        }
        card.append(row);
        if (m.baseSize) card.append(el('div', { class: 'sub' }, `Base: ${m.baseSize}`));
      }
      out.append(card);
    }

    function weaponSection(title, melee) {
      const items = (ds.weapons || []).filter(w => w.isMelee === melee);
      if (!items.length) return null;
      const card = el('div', { class: 'card' }, el('h3', {}, title));
      for (const w of items) {
        const stats = el('div', { class: 'weapon-stats' });
        if (!melee && w.range) stats.append(el('span', { class: 'chip' }, `Range ${w.range}"`));
        for (const [lbl, val] of [
          ['A', w.A], [melee ? 'WS' : 'BS', w.BS_WS],
          ['S', w.S], ['AP', w.AP], ['D', w.D],
        ]) {
          stats.append(el('span', { class: 'chip' }, `${lbl} ${val ?? '—'}`));
        }
        const wrap = el('div', { class: 'weapon' }, [
          el('div', { class: 'weapon-head' }, el('span', { class: 'weapon-name' }, w.name)),
          stats,
        ]);
        if (w.description) {
          const d = el('div', { class: 'weapon-desc' });
          d.appendChild(renderRulesHTML(w.description));
          wrap.append(d);
        }
        card.append(wrap);
      }
      return card;
    }
    out.append(weaponSection('Ranged Weapons', false));
    out.append(weaponSection('Melee Weapons', true));

    const validAbilities = (ds.abilities || []).filter(a => a.name || a.description);
    if (validAbilities.length) {
      const card = el('div', { class: 'card' }, el('h3', {}, 'Abilities'));
      for (const a of validAbilities) {
        const block = el('div', { style: 'margin: 8px 0' });
        if (a.name) block.append(el('div', { style: 'font-weight:600' }, a.name));
        if (a.description) block.appendChild(renderRulesHTML(a.description));
        card.append(block);
      }
      out.append(card);
    }

    if (ds.composition && ds.composition.length) {
      const card = el('div', { class: 'card' }, [
        el('h3', {}, 'Unit Composition'),
        ...ds.composition.map(c => {
          const d = el('div', { style: 'margin: 4px 0' });
          d.appendChild(renderRulesHTML(c));
          return d;
        }),
      ]);
      out.append(card);
    }

    if (ds.keywords && ds.keywords.length) {
      const unit = [...new Set(ds.keywords.filter(k => !k.isFactionKeyword).map(k => k.keyword))].sort();
      const fac = [...new Set(ds.keywords.filter(k => k.isFactionKeyword).map(k => k.keyword))].sort();
      const card = el('div', { class: 'card' }, el('h3', {}, 'Keywords'));
      if (unit.length) card.append(el('div', { style: 'font-size:14px' }, unit.join(', ')));
      if (fac.length) card.append(el('div', { class: 'sub' }, 'Faction: ' + fac.join(', ')));
      out.append(card);
    }

    return out;
  }

  // ---------------- Views: Detachments ----------------

  async function viewDetachments() {
    setTitle('Detachments');
    const idx = await loadIndex();
    await loadSearch();
    const factionsById = Object.fromEntries(idx.factions.map(f => [f.id, f.name]));

    const ts = tabSearch({
      placeholder: 'Search all detachments…',
      type: 'd',
      makeHref: h => `#/detachment/${h.f}/${h.i}`,
      factionsById,
    });

    const factionList = el('ul', { class: 'list' },
      idx.factions.map(f => el('li', {}, el('a', { href: `#/faction-detachments/${f.id}` }, f.name)))
    );
    ts.input.addEventListener('input', () => { factionList.hidden = ts.isActive(); });

    return el('div', {}, [ts.input, ts.results, factionList]);
  }

  async function viewFactionDetachments(id) {
    const b = await loadFaction(id);
    setTitle(b.faction.name);
    return el('ul', { class: 'list' },
      b.detachments.map(d => el('li', {}, el('a', { href: `#/detachment/${id}/${d.id}` }, d.name)))
    );
  }

  async function viewDetachment(factionId, detId) {
    const b = await loadFaction(factionId);
    await loadKeywords();
    const det = b.detachments.find(d => d.id === detId);
    if (!det) return el('div', { class: 'empty' }, 'Detachment not found.');
    setTitle(det.name);

    const out = el('div');

    if (det.abilities.length) {
      const card = el('div', { class: 'card' }, el('h3', {}, 'Detachment Rule'));
      for (const a of det.abilities) {
        const block = el('div', { style: 'margin: 8px 0' });
        block.append(el('div', { style: 'font-weight:600' }, a.name));
        if (a.description) block.appendChild(renderRulesHTML(a.description));
        card.append(block);
      }
      out.append(card);
    }

    if (det.stratagems.length) {
      const card = el('div', { class: 'card' }, el('h3', {}, 'Stratagems'));
      for (const s of det.stratagems) {
        const summary = el('summary', { class: 'strat-head' }, [
          el('div', {}, [
            el('div', { style: 'font-weight:600' }, s.name),
            s.type ? el('div', { class: 'strat-meta' }, s.type) : null,
            (s.turn || s.phase)
              ? el('div', { class: 'strat-meta' }, [s.turn, s.phase].filter(Boolean).join(' · '))
              : null,
          ].filter(Boolean)),
          s.cpCost ? el('span', { class: 'cp' }, `${s.cpCost} CP`) : null,
        ].filter(Boolean));
        const body = el('div', { class: 'strat-body' });
        if (s.description) body.appendChild(renderRulesHTML(s.description));
        const det = el('details', {}, [summary, body]);
        card.append(det);
      }
      out.append(card);
    }

    if (det.enhancements.length) {
      const card = el('div', { class: 'card' }, el('h3', {}, 'Enhancements'));
      for (const e of det.enhancements) {
        const block = el('div', { style: 'margin: 10px 0' });
        block.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' }, [
          el('span', { style: 'font-weight:600' }, e.name),
          e.cost ? el('span', { class: 'pts' }, `${e.cost} pts`) : null,
        ].filter(Boolean)));
        if (e.description) block.appendChild(renderRulesHTML(e.description));
        card.append(block);
      }
      out.append(card);
    }
    return out;
  }

  // ---------------- Views: Rules ----------------

  const RULES_GROUPS = [
    { label: 'Game Setup', match: ['Books', 'Missions', 'Armies', 'Battlefield', 'Measuring Distances', 'Determining Visibility', 'Dice', 'Sequencing'] },
    { label: 'Command Phase', match: ['1. Command', '2. Battle-shock'] },
    { label: 'Movement Phase', match: ['1. Move Units', '2. Reinforcements', 'Transports'] },
    { label: 'Shooting Phase', match: ['1. Hit Roll', '2. Wound Roll', '3. Allocate Attack', '4. Saving Throw', '5. Inflict Damage'] },
    { label: 'Charge / Fight Phase', match: ['1. Fights First', '2. Remaining Combats', '1. Pile In', '2. Make Melee Attacks', '3. Consolidate'] },
    { label: 'Terrain', match: ['Craters and Rubble', 'Barricades and Fuel Pipes', 'Battlefield Debris and Statuary', 'Hills, Industrial Structures, Sealed Buildings and Armoured Containers', 'Woods', 'Ruins', 'Example Battlefields'] },
    { label: 'Building an Army', match: ['Muster Your Army', 'Objective Markers', 'Mission Map Key'] },
  ];

  async function viewRules() {
    setTitle('Core Rules');
    const r = await loadRules();
    if (!r.sections.length) {
      return el('div', { class: 'empty' }, 'Rules unavailable. The scraper may have failed on the last build — check back tomorrow.');
    }
    await loadSearch();

    const ts = tabSearch({
      placeholder: 'Search rules…',
      type: 'r',
      makeHref: h => `#/rules/${h.i}`,
    });

    const bySlug = Object.fromEntries(r.sections.map(s => [s.title, s]));
    const toc = el('div');
    const seen = new Set();
    for (const grp of RULES_GROUPS) {
      const items = grp.match.map(t => bySlug[t]).filter(Boolean);
      if (!items.length) continue;
      toc.append(el('div', { class: 'rules-toc-group' }, grp.label));
      const ul = el('ul', { class: 'list' },
        items.map(s => {
          seen.add(s.slug);
          return el('li', {}, el('a', { href: `#/rules/${s.slug}` }, s.title));
        })
      );
      toc.append(ul);
    }
    const leftover = r.sections.filter(s => !seen.has(s.slug));
    if (leftover.length) {
      toc.append(el('div', { class: 'rules-toc-group' }, 'Other'));
      toc.append(el('ul', { class: 'list' },
        leftover.map(s => el('li', {}, el('a', { href: `#/rules/${s.slug}` }, s.title)))
      ));
    }
    ts.input.addEventListener('input', () => { toc.hidden = ts.isActive(); });

    return el('div', {}, [ts.input, ts.results, toc]);
  }

  async function viewRulesSection(slug) {
    const r = await loadRules();
    await loadKeywords();
    const sec = r.sections.find(s => s.slug === slug);
    if (!sec) return el('div', { class: 'empty' }, 'Section not found.');
    setTitle(sec.title);
    const card = el('div', { class: 'card rules' });
    card.append(el('h2', { style: 'margin-top:0' }, sec.title));
    const body = el('div');
    body.innerHTML = sec.html;
    linkifyKeywords(body);
    card.append(body);
    return card;
  }

  // ---------------- Views: Keywords ----------------

  async function viewKeywords() {
    setTitle('Keywords');
    const k = await loadKeywords();
    if (!k.keywords.length) {
      return el('div', { class: 'empty' }, 'Keywords unavailable. The scraper may have failed on the last build.');
    }
    const search = el('input', { class: 'search-input', placeholder: 'Search keywords…', type: 'search' });
    const ul = el('ul', { class: 'list' });
    const TYPE_LABEL = { weapon: 'Weapon', ability: 'Ability', rule: 'Rule' };
    function render(q) {
      q = q.trim().toLowerCase();
      const items = q.length < 1
        ? k.keywords
        : k.keywords.filter(kw => kw.name.toLowerCase().includes(q));
      ul.replaceChildren(...items.map(kw =>
        el('li', {}, el('a', { href: `#/keyword/${kw.slug}` }, [
          kw.name,
          el('span', { class: 'sub' }, TYPE_LABEL[kw.type] || 'Rule'),
        ]))
      ));
    }
    render('');
    search.addEventListener('input', e => render(e.target.value));
    return el('div', {}, [search, ul]);
  }

  async function viewKeyword(slug) {
    const k = await loadKeywords();
    const kw = k.keywords.find(x => x.slug === slug);
    if (!kw) return el('div', { class: 'empty' }, 'Keyword not found.');
    setTitle(kw.name);
    const card = el('div', { class: 'card rules' });
    const TYPE_LABEL = { weapon: 'Weapon ability', ability: 'Unit ability', rule: 'Rule' };
    card.append(el('h2', { style: 'margin-top:0' }, kw.name));
    card.append(el('div', { class: 'sub', style: 'margin-bottom:10px' }, TYPE_LABEL[kw.type] || 'Rule'));
    const body = el('div');
    body.innerHTML = kw.html;
    // Linkify too — keywords often reference other keywords (e.g. Sustained
    // Hits mentions Critical Hit). But avoid linking the keyword to itself.
    linkifyKeywords(body);
    for (const a of body.querySelectorAll(`a[href="#/keyword/${slug}"]`)) {
      const span = document.createElement('span');
      span.style.fontWeight = '600';
      span.textContent = a.textContent;
      a.replaceWith(span);
    }
    card.append(body);
    return card;
  }

  // ---------------- Views: About ----------------

  async function viewAbout() {
    setTitle('About');
    const idx = await loadIndex();
    return el('div', { class: 'about' }, [
      el('p', {}, [
        'Wahapp is a personal mirror of ', el('a', { href: 'https://wahapedia.ru', target: '_blank', rel: 'noopener' }, 'Wahapedia'),
        '. All Warhammer 40,000 game data is sourced from Wahapedia and refreshed daily.',
      ]),
      el('p', {}, `Last update: ${idx.lastUpdate || 'unknown'}`),
      el('p', {}, 'Warhammer 40,000 and all associated marks are © Games Workshop. This is a personal companion, not an official product.'),
      el('p', {}, [
        'Add to home screen on iOS: Share button → "Add to Home Screen".',
      ]),
    ]);
  }

  // ---------------- Router ----------------

  const routes = [
    { re: /^#\/?$/, handler: viewUnits, tab: 'units' },
    { re: /^#\/units\/?$/, handler: viewUnits, tab: 'units' },
    { re: /^#\/faction\/([^/]+)\/?$/, handler: (m) => viewFaction(m[1]), tab: 'units' },
    { re: /^#\/unit\/([^/]+)\/([^/]+)\/?$/, handler: (m) => viewUnit(m[1], m[2]), tab: 'units' },
    { re: /^#\/detachments\/?$/, handler: viewDetachments, tab: 'detachments' },
    { re: /^#\/faction-detachments\/([^/]+)\/?$/, handler: (m) => viewFactionDetachments(m[1]), tab: 'detachments' },
    { re: /^#\/detachment\/([^/]+)\/([^/]+)\/?$/, handler: (m) => viewDetachment(m[1], m[2]), tab: 'detachments' },
    { re: /^#\/rules\/?$/, handler: viewRules, tab: 'rules' },
    { re: /^#\/rules\/([^/]+)\/?$/, handler: (m) => viewRulesSection(m[1]), tab: 'rules' },
    { re: /^#\/keywords\/?$/, handler: viewKeywords, tab: 'keywords' },
    { re: /^#\/keyword\/([^/]+)\/?$/, handler: (m) => viewKeyword(m[1]), tab: 'keywords' },
    { re: /^#\/about\/?$/, handler: viewAbout, tab: 'about' },
  ];

  function setTitle(t) { $('#title').textContent = t; }
  function setActiveTab(tab) {
    for (const a of document.querySelectorAll('#tabs a')) {
      a.classList.toggle('active', a.dataset.tab === tab);
    }
  }

  let navStack = [];

  async function route() {
    const hash = location.hash || '#/units';
    const app = $('#app');
    app.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));

    if (hash !== navStack[navStack.length - 1]) navStack.push(hash);
    $('#back').hidden = navStack.length <= 1;

    for (const { re, handler, tab } of routes) {
      const m = hash.match(re);
      if (m) {
        setActiveTab(tab);
        try {
          const view = await handler(m);
          app.replaceChildren(view);
          window.scrollTo(0, 0);
        } catch (err) {
          console.error(err);
          app.replaceChildren(el('div', { class: 'error' }, `Error: ${err.message}`));
        }
        return;
      }
    }
    app.replaceChildren(el('div', { class: 'empty' }, 'Page not found.'));
  }

  $('#back').addEventListener('click', () => {
    if (navStack.length > 1) {
      navStack.pop();
      const prev = navStack.pop();
      location.hash = prev;
    } else {
      history.back();
    }
  });

  // Eagerly preload the small cross-cutting indexes so per-tab search is
  // instant when the user starts typing, and so linkify is ready by the
  // time they open a unit/stratagem/rule.
  loadSearch().catch(() => {});
  loadKeywords().catch(() => {});

  window.addEventListener('hashchange', route);
  window.addEventListener('load', route);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
