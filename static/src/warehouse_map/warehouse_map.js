import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";
import { session } from "@web/session";
import { cookie } from "@web/core/browser/cookie";
import { Component, useRef, onMounted } from "@odoo/owl";

const C = {
    // Paleta de colores del mapa.
    avail: "#22c55e", occup: "#ef4444", reserv: "#f97316",
    aisle: "#f1f5f9", cross: "#fef9c3",
    hdr: "#1e293b", hdrAisle: "#475569", hdrSpec: "#57534e",
};
// Rellena un número a 2 dígitos ("3" -> "03").
function z(n) { return String(n).padStart(2,"0"); }

class WarehouseMap extends Component {
    static template = "stock_warehouse_map.WarehouseMapGrid";

    setup() {
        this.orm = useService("orm");
        this.root = useRef("root");
        this.whs = []; this.whId = null; this.data = null;
        this.tip = null; this.tipPos = null;
        this.selected = null;
        this._stats = null; this._dirty = false; this._tipDragged = false;
        onMounted(() => this.start());
    }

    // Arranque: carga los almacenes disponibles y el del usuario (PR01).
    async start() {
        try {
            let whRes = null;
            try { whRes = await rpc("/warehouse_map/get_warehouses"); }
            catch (e) { whRes = null; }
            if (whRes && whRes.warehouses) {
                this.whs = whRes.warehouses;
            } else {
                const cids = cookie.get("cids");
                const companyId = cids
                    ? String(cids).split("-").map(Number).find((n) => n > 0)
                    : session.user_companies?.current_company;
                this.whs = await this.orm.searchRead("stock.warehouse", [
                    ["company_id", "=", companyId],
                ], ["name", "code"]);
            }
            const main = this.whs.find((w) => this._isMargarita(w))
                || this.whs.find((w) => /principal/i.test(w.name));
            this._mainWhId = main ? main.id : (this.whs.length ? this.whs[0].id : null);
            if (this.whs.length) {
                this.whId = this._mainWhId || this.whs[0].id;
                await this.loadIfAllowed(this.whId);
            }
            this.draw();
        } catch (e) { this.showError(e?.message); }
    }

    // El almacén principal es PR01 ("Margarita"). Solo él tiene mapa 2D.
    _isMargarita(w) {
        if (!w) return false;
        if (w.code) return String(w.code).trim().toUpperCase() === "PR01";
        return /margarita/i.test(w.name) && /principal/i.test(w.name);
    }

    // Bloquea el mapa para almacenes que no sean PR01.
    async loadIfAllowed(id) {
        const wh = this.whs.find((w) => w.id === id);
        this._notAllowed = !this._isMargarita(wh);
        this._err = null;
        this.data = null;
        if (!this._notAllowed) {
            try { await this.load(id); }
            catch (e) { this._err = e?.message || String(e); }
        }
    }
    // Pide los datos del mapa (racks + ocupación) al servidor.
    async load(id) {
        const r = await rpc("/warehouse_map/get_map_data", { warehouse_id: id });
        if (r.error) throw new Error(r.error);
        this.data = r;
        this._err = null;
        this._dirty = false;
        this.recomputeStats();
    }
    async onWhChange(ev) {
        this.whId = parseInt(ev.target.value);
        this._detachTipListeners();
        this.tip = null;
        this.selected = null;
        this._stats = null;
        await this.loadIfAllowed(this.whId);
        this.draw();
    }

    // Escapa HTML para evitar inyección en los strings de la grilla.
    esc(s) { return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

    // Nombre legible del rack para la cabecera de columna.
    rackTitle(r) {
        if (r.type === "aisle") return "PASILLO " + r.name.replace("PASILLO ","");
        if (r.type === "special") return "PASILLO 6";
        return "RACK " + r.name.replace("RACK ","");
    }

    // Recalcula los contadores globales (total/libre/ocupado/reservado).
    recomputeStats() {
        const occ = this.data?.occupancy;
        if (!occ) { this._stats = null; return; }
        let total = 0, occupied = 0, reserved = 0;
        for (const rackName in occ) {
            for (const pos in occ[rackName]) {
                const pd = occ[rackName][pos];
                if (pd?.isAisle) continue;
                for (const pal of (pd?.pallets||[])) {
                    for (const lv of Object.values(pal.levels||{})) {
                        total++;
                        if (lv.occupied) occupied++;
                        if (lv.reserved) reserved++;
                    }
                }
            }
        }
        const free = total - occupied - reserved;
        this._stats = { total, free, occupied, reserved, percentage: total ? Math.round((occupied+reserved)/total*100) : 0 };
    }

    // Color de un nivel según su estado (libre/ocupado/reservado).
    dotColor(rack, pos, palIdx, level) {
        const o = this.data?.occupancy?.[rack]?.[pos];
        if (!o || o.isAisle) return null;
        const pal = o.pallets?.[palIdx];
        if (!pal || pal.free) return C.avail;
        const lv = pal.levels?.[level];
        if (!lv) return C.avail;
        if (lv.reserved) return C.reserv;
        if (lv.occupied) return C.occup;
        return C.avail;
    }

    // Estado general de una posición: "free" | "reserved" | "occupied".
    posStatus(rack, pos) {
        const o = this.data?.occupancy?.[rack]?.[pos];
        if (!o || o.isAisle) return null;
        const anyOcc = o.pallets?.some(p => !p.free);
        if (!anyOcc) return "free";
        const anyRes = o.pallets?.some(p => Object.values(p.levels||{}).some(l=>l.reserved));
        if (anyRes) return "reserved";
        return "occupied";
    }

    showError(m) { const e=this.root.el; if(e) e.innerHTML=`<div class="alert alert-danger m-3">${this.esc(m||"Error desconocido")}</div>`; }

    // Construye y monta toda la UI del mapa (top bar, leyenda, grilla, sidebar).
    draw() {
        const el = this.root.el;
        if (!el) return;
        if (!this.whs.length) return this._msg("No hay almacenes configurados");

        const oldGrid = el.querySelector('.flex-grow-1.overflow-auto');
        const savedScroll = oldGrid ? { top: oldGrid.scrollTop, left: oldGrid.scrollLeft } : null;

        let h = "";

        /* ===== TOP BAR ===== */
        const s = this._stats;
        h += `<div class="d-flex align-items-center gap-2 px-3 pt-3 pb-2 flex-wrap" style="flex-shrink:0">
            <label class="text-muted small fw-semibold text-uppercase" style="font-size:11px;letter-spacing:.5px">Almacén</label>
            <select class="form-select form-select-sm border-0 bg-light fw-semibold" style="width:auto;min-width:150px;box-shadow:0 1px 2px rgba(0,0,0,.05);font-size:13px;border-radius:8px">`;
        for (const w of this.whs) h += `<option value="${w.id}"${w.id===this.whId?" selected":""}>${this.esc(w.code?w.code+" · ":"")}${this.esc(w.name)}</option>`;
        h += `</select>`;
        if (s) {
            h += `<div class="d-flex gap-2 ms-auto flex-wrap align-items-center">
                <div style="width:140px">
                    <div class="d-flex justify-content-between small mb-1">
                        <span style="font-size:10px;color:#64748b;font-weight:600">Ocupación</span>
                        <span style="font-size:10px;color:#64748b;font-weight:600">${s.percentage}%</span>
                    </div>
                    <div class="progress rounded-pill" style="height:8px;background:#e2e8f0">
                        <div class="progress-bar rounded-pill" style="width:${s.percentage}%;background:${s.percentage>80?'#ef4444':s.percentage>50?'#f59e0b':'#22c55e'}"></div>
                    </div>
                </div>
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#e8f5e9;color:#2e7d32;font-size:11px"><i class="fa fa-circle-o text-success me-1"></i>${s.free} libres</span>
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#ffebee;color:#c62828;font-size:11px"><i class="fa fa-check-circle text-danger me-1"></i>${s.occupied} ocupadas</span>
            </div>`;
        }
        if (this._dirty) {
            h += `<button class="btn btn-sm btn-success ms-2" style="border-radius:8px;font-size:12px;font-weight:600" onclick="window._owh&&window._owh.saveChanges()"><i class="fa fa-save me-1"></i>Guardar</button>`;
        }
        h += `</div>`;

        /* ===== LEGEND ===== */
        h += `<div class="d-flex flex-wrap align-items-center gap-3 px-3 pb-3 small text-muted" style="flex-shrink:0">`;
        const leg = (bg,label) => `<span class="d-inline-flex align-items-center gap-1"><span class="d-inline-block rounded" style="width:12px;height:12px;background:${bg}"></span>${label}</span>`;
        h += leg(C.avail,"Disponible")+leg(C.occup,"Ocupado")+leg(C.reserv,"Reservado")+leg(C.aisle,"Pasillo");
        h += `</div>`;

        /* ===== BODY ===== */
        h += `<div class="d-flex flex-grow-1" style="min-height:0">`;

        if (!this.data || !this.data.racks) {
            let msg, isSpin = false;
            if (this._notAllowed) {
                msg = "El mapa 2D solo está disponible para el almacén 'Almacen Principal - Margarita' (PR01). Seleccione ese almacén en el desplegable.";
            } else {
                msg = this._err || "Cargando...";
                isSpin = !this._err;
            }
            h += `<div class="d-flex align-items-center justify-content-center flex-grow-1"><div class="text-center text-muted">${isSpin?`<div class="spinner-border text-primary mb-3" role="status"></div>`:""}<div>${this.esc(msg)}</div></div></div>`;
            h += `</div>`;
            el.innerHTML = h;
            window._owh = this;
            const sel = el.querySelector("select");
            if (sel) sel.onchange = (ev) => this.onWhChange(ev);
            return;
        }

        const { racks, occupancy, companyColors } = this.data;
        const maxPos = racks.filter(r=>r.type==="rack").reduce((m,r)=>Math.max(m,r.totalPositions),0);
        const cW = 64;
        const dS = 8;
        const dG = 4;

        /* ===== GRID ===== */
        h += `<div class="flex-grow-1 overflow-auto p-2">`;
        h += `<table class="table table-sm align-middle mb-0" style="border-collapse:collapse;font-size:10px;width:auto;table-layout:fixed">`;

        /* ---- HEADER ROW 1: Rack names ---- */
        h += `<thead><tr>`;
        for (const r of racks) {
            if (r.type==="special") {
                h += `<th colspan="1" class="text-white text-center fw-bold" style="background:${C.hdr};width:300px;min-width:300px;padding:5px 1px 3px;font-size:9px;letter-spacing:.5px;border:1px solid rgba(255,255,255,.08)">PASILLO 6</th>`;
                continue;
            }
            const bg = r.type==="aisle"?C.hdrAisle:C.hdr;
            h += `<th colspan="1" class="text-white text-center fw-bold"
                style="background:${bg};width:${cW+4}px;min-width:${cW+4}px;padding:5px 1px 3px;font-size:9px;letter-spacing:.5px;border:1px solid rgba(255,255,255,.08);overflow:hidden">${this.esc(this.rackTitle(r))}</th>`;
        }
        h += `</tr></thead><tbody>`;

        /* ---- ROWS ---- */
        for (let p = 1; p <= maxPos; p++) {
            const isCross = p===15||p===37;
            h += `<tr${isCross?` style="background:${C.cross}"`:""}>`;
            for (const r of racks) {
                if (r.type==="aisle") {
                    h += `<td style="background:${C.aisle};padding:0;text-align:center;font-size:7px;color:#94a3b8;border:1px solid #e2e8f0;vertical-align:middle">${isCross?"⇄":""}</td>`;
                } else if (r.type==="special") {
                    if (p === 1) {
                        const p6Html = this._buildPasillo6();
                        h += `<td rowspan="${maxPos}" style="padding:2px;border:1px solid #e2e8f0;background:${C.aisle};vertical-align:top;overflow:visible">${p6Html}</td>`;
                    }
                    continue;
                } else if (p > r.totalPositions) {
                    h += `<td style="background:#fafafa;padding:0;text-align:center;border:1px solid #e2e8f0">
                        <button onclick="window._owh&&window._owh.extendRack('${this.esc(r.name)}',${p},event)"
                            style="background:none;border:1px dashed #cbd5e1;border-radius:3px;color:#94a3b8;cursor:pointer;font-size:10px;line-height:16px;width:18px;height:18px;padding:0"
                            title="Agregar posición ${p}">+</button>
                    </td>`;
                } else {
                    const o = occupancy?.[r.name]?.[p];
                    const status = this.posStatus(r.name, p);

                    if (o?.isAisle) {
                        h += `<td style="background:${C.aisle};padding:0;text-align:center;font-size:7px;color:#94a3b8;border:1px solid #e2e8f0">${isCross?"⇄":"│"}</td>`;
                    } else {
                        const palN = o?.pallets ? Math.min(6, Math.max(2, o.pallets.length)) : 2;
                        const maxLv = o?.pallets?.length ? o.pallets.reduce((m,pa)=>Math.max(m,...Object.keys(pa.levels||{}).map(Number)),0) : 0;
                        const lvN = Math.min(6, Math.max(r.totalLevels||3, maxLv));

                        const rl = r.name.replace("RACK ","");
                        const inv = r.name==="RACK B"||r.name==="RACK D"||r.name==="RACK F";
                        const lo = inv ? 3 : 1, po = 2, zo = inv ? 1 : 3;
                        const lp = p - (p>15?1:0) - (p>37?1:0);
                        const fp = 2*lp - 1;
                        let dots = `<div style="display:flex;flex-direction:column;gap:3px">`;
                        for (let sl = 0; sl < palN; sl++) {
                            const label = `<span style="display:inline-block;font-size:7px;font-weight:700;color:#94a3b8;line-height:8px;width:20px;text-align:center;overflow:hidden;order:${lo}">${rl}${z(fp + sl)}</span>`;
                            const pipe = `<span style="font-size:7px;color:#94a3b8;line-height:8px;order:${po}">|</span>`;
                            let dhtml = "";
                            for (let lv = 1; lv <= lvN; lv++) {
                                const c = this.dotColor(r.name, p, sl, lv)||C.avail;
                                dhtml += `<div style="width:${dS}px;height:${dS}px;background:${c};border-radius:1px;flex-shrink:0;order:${zo}"></div>`;
                            }
                            dots += `<div style="display:flex;gap:2px;align-items:center;justify-content:center">${label}${pipe}${dhtml}</div>`;
                        }
                        dots += `</div>`;

                        h += `<td class="wh-cell${status==="occupied"||status==="reserved"?" has-stock":""}"
                            style="height:${palN>2?24+(palN-2)*12:24}px;padding:2px 2px;text-align:center;cursor:pointer;border:1px solid #e2e8f0;background:#fff;vertical-align:middle"
                            data-rack="${this.esc(r.name)}" data-pos="${p}"
                            draggable="true"
                            ondragstart="window._owh&&window._owh.dragStart(event)"
                            ondragover="window._owh&&window._owh.dragOver(event)"
                            ondrop="window._owh&&window._owh.drop(event)"
                            onclick="var d=this.dataset;window._owh&&window._owh.toggleTip(d.rack,parseInt(d.pos),event)">${dots}</td>`;
                    }
                }
            }
            h += `</tr>`;
        }
        h += `</tbody></table>`;

        h += `</div>`;

        /* ===== SIDEBAR ===== */
        h += this._buildSidebar(occupancy, companyColors);

        h += `</div>`;

        el.innerHTML = h;
        window._owh = this;
        const sel = el.querySelector("select");
        if (sel) sel.onchange = (ev) => this.onWhChange(ev);
        this._renderTooltip(el);
        if (savedScroll) {
            const ng = el.querySelector('.flex-grow-1.overflow-auto');
            if (ng) { ng.scrollTop = savedScroll.top; ng.scrollLeft = savedScroll.left; }
        }
    }

    _msg(text, spin) {
        const el = this.root.el;
        if (!el) return;
        el.innerHTML = `<div class="d-flex align-items-center justify-content-center h-100"><div class="text-center text-muted">${spin?`<div class="spinner-border text-primary mb-3" role="status"></div>`:""}<div>${this.esc(text)}</div></div></div>`;
    }

    // Sidebar con el detalle de la posición seleccionada (rack, niveles, productos).
    _buildSidebar(occ, companyColors) {
        let h = `<div class="border-start bg-light p-3" style="width:300px;min-width:260px;min-height:0;overflow:auto;flex-shrink:0">`;
        h += `<div class="d-flex align-items-center gap-2 mb-3">
            <span class="badge bg-dark fw-bold" style="font-size:10px;padding:4px 10px;letter-spacing:.5px">PUESTO</span>
        </div>`;

        if (!this.selected) {
            h += `<div class="text-muted small text-center py-4" style="font-size:11px">Haz clic en una posición para ver su información.</div>`;
            return h + `</div>`;
        }

        const { rack, pos } = this.selected;
        if (rack === 'PASILLO 6') {
            h += `<div class="fw-bold mb-2" style="font-size:13px">PASILLO 6 · ${z(pos)}</div>
                <div class="text-muted small" style="font-size:11px">Este pasillo no está mapeado.</div>`;
            return h + `</div>`;
        }

        const rackCfg = this.data.racks.find(r => r.name === rack);
        const o = occ?.[rack]?.[pos];
        if (!o || o.isAisle) {
            h += `<div class="fw-bold mb-2" style="font-size:13px">${this.esc(rack)} · ${z(pos)}</div>
                <div class="text-muted small" style="font-size:11px">Sin información para esta posición.</div>`;
            return h + `</div>`;
        }

        const rl = rack.replace("RACK ","");
        const lp = pos - (pos>15?1:0) - (pos>37?1:0);
        const title = rackCfg ? this.rackTitle(rackCfg) : rack;
        h += `<div class="fw-bold mb-2" style="font-size:13px">${this.esc(title)} · ${z(pos)}</div>`;

        const palN = o.pallets?.length || 0;
        for (let pi = 0; pi < palN; pi++) {
            const pal = o.pallets[pi];
            const pName = 2*lp - 1 + pi;
            for (const lv in (pal.levels||{})) {
                const ld = pal.levels[lv];
                const short = `${rl}${z(pName)}-${lv}`;
                const fullName = ld.complete_name ? this.esc(ld.complete_name) : this.esc(short);
                let companyHtml = '';
                if (ld.company_id && companyColors?.[ld.company_id]) {
                    const cc = companyColors[ld.company_id];
                    companyHtml = `<div class="fw-semibold mt-1" style="font-size:11px;color:${cc.color||'#6c757d'}"><i class="fa fa-building-o me-1"></i>${this.esc(cc.name||'')}</div>`;
                }
                let prodsHtml = '';
                const prods = ld.products || [];
                if (ld.occupied && prods.length) {
                    prodsHtml = prods.map(p =>
                        `<div class="text-danger" style="font-size:10px;word-break:break-word">• ${this.esc(p.name)} ${p.qty?`<span class="text-muted">(${p.qty}${p.uom?' '+this.esc(p.uom):''}${p.lot?' · '+this.esc(p.lot):''})</span>`:''}</div>`
                    ).join('');
                } else {
                    prodsHtml = `<div style="font-size:10px;color:#64748b">Disponible</div>`;
                }
                h += `<div class="py-2" style="border-bottom:1px solid #e2e8f0">
                    <div class="fw-bold" style="font-size:11px">${this.esc(short)}</div>
                    <div class="text-muted" style="font-size:9px;word-break:break-word">${fullName}</div>
                    ${companyHtml}
                    <div class="mt-1">${prodsHtml}</div>
                </div>`;
            }
        }
        return h + `</div>`;
    }

    // Esquema decorativo del PASILLO 6 (almacenamiento en piso, sin mapeo real aún).
    _buildPasillo6() {
        if (!this.data?.occupancy?.["PASILLO 6"]) return '';
        const BB = '#e2e8f0';
        const CS = 12, RH = 12;
        const cell = (pos, palletIdx) => {
            if (pos === 15 || pos === 37) return '';
            const o = this.data?.occupancy?.["PASILLO 6"]?.[pos];
            const pal = o?.pallets?.[palletIdx];
            const levels = pal?.levels || {};
            const lvNums = Object.keys(levels).map(Number).sort();
            let sections = '';
            for (const lv of lvNums) {
                const ld = levels[lv];
                const bg = ld?.reserved ? '#f59e0b' : ld?.occupied ? '#ef4444' : '#22c55e';
                sections += `<div style="flex:1;background:${bg};border-bottom:${lv===lvNums[lvNums.length-1]?'none':'1px solid rgba(255,255,255,.4)'}"></div>`;
            }
            if (!lvNums.length) {
                sections = `<div style="flex:1;background:#22c55e"></div>`;
            }
            return `<div class="wh-cell" data-rack="PASILLO 6" data-row="${pos}" data-cell="${palletIdx}"
                onclick="var d=this.dataset;window._owh&&window._owh.toggleTip(d.rack,parseInt(d.row),event,parseInt(d.cell))"
                title="PASILLO 6 · ${z(pos)}-${z(palletIdx+1)}"
                style="width:${CS}px;height:${RH}px;flex-shrink:0;position:relative;cursor:pointer;display:flex;flex-direction:column;border:1px solid ${BB};overflow:hidden;border-radius:2px">
                ${sections}
            </div>`;
        };
        const row2 = (arr, n, sp, startPallet, stride, posOffset = 0) => {
            let h = '';
            for (let i = 0; i < arr.length; i++) {
                const pos = sp + i + posOffset;
                h += `<div style="display:flex">`;
                for (let p = 0; p < n; p++) h += cell(pos, startPallet + p);
                h += `</div>`;
                h += `<div style="display:flex">`;
                for (let p = 0; p < n; p++) h += cell(pos, startPallet + stride + p);
                h += `</div>`;
            }
            return h;
        };
        const blk = (larr, rarr, sp, rOff = 0) => {
            const lc = 6, rc = 11;
            return `<div style="display:flex;gap:0">
                <div style="display:flex;flex-direction:column;width:${(CS+2)*lc}px">${row2(larr,lc,sp,0,6,0)}</div>
                <div style="width:36px;flex-shrink:0;background:${C.aisle}"></div>
                <div style="display:flex;flex-direction:column;width:${(CS+2)*rc}px">${row2(rarr,rc,sp,12,11,rOff)}</div>
            </div>`;
        };
        const crossBar = () => {
            const w = (CS+2)*6, w2 = (CS+2)*11;
            return `<div style="display:flex;gap:0;height:${RH}px;flex-shrink:0;border:1px solid ${BB}">
                <div style="width:${w}px;display:flex;align-items:center;padding:0 6px;border-right:1px solid ${BB};background:${C.aisle}"><span style="font-size:9px;color:#a78bfa;font-weight:600">⇄</span></div>
                <div style="width:36px;flex-shrink:0;background:${C.aisle}"></div>
                <div style="width:${w2}px;display:flex;align-items:center;padding:0 6px;border-left:1px solid ${BB};background:${C.aisle}"><span style="font-size:9px;color:#a78bfa;font-weight:600">⇄</span></div>
            </div>`;
        };
        const range = (from, to) => {
            const a = [];
            for (let i = from; i <= to; i++) a.push(i);
            return a;
        };
        let ph = '';
        ph += blk(range(1,14), range(1,14), 1, 43);
        ph += crossBar();
        ph += blk(range(16,18), range(16,18), 16, 43);
        ph += `<div style="height:${RH}px;background:${C.aisle}"></div>`;
        ph += blk(range(20,22), range(20,22), 20, 43);
        ph += `<div style="height:${RH}px;background:${C.aisle}"></div>`;
        ph += blk(range(23,36), range(23,36), 23, 43);
        ph += crossBar();
        ph += blk(range(38,43), range(38,43), 38, 43);
        return ph;
    }

    // Extiende un rack una posición más (botón "+" al final de la columna).
    extendRack(rackName, pos, ev) {
        ev?.stopPropagation();
        const rack = this.data.racks.find(r => r.name === rackName);
        if (!rack || pos <= rack.totalPositions) return;
        rack.totalPositions = pos;
        if (!this.data.occupancy[rackName]) this.data.occupancy[rackName] = {};
        if (!this.data.occupancy[rackName][pos]) {
            const palN = Math.max(2, rack.palletsPerRow || 2);
            const pallets = [];
            for (let i = 0; i < palN; i++) {
                const lvs = {};
                for (let lv = 1; lv <= (rack.totalLevels || 3); lv++) lvs[lv] = {occupied: false, reserved: false};
                pallets.push({free: true, product: null, levels: lvs});
            }
            this.data.occupancy[rackName][pos] = {pallets, product: null, company_id: null};
        }
        this._markDirty();
        this.draw();
    }

    // Abre/cierra el tooltip de una celda. Para PASILLO 6 completa hasta 34 celdas.
    toggleTip(rack, pos, ev, cellIdx) {
        const d = this.data?.occupancy?.[rack]?.[pos];
        if (!d?.pallets) return;
        this.selected = { rack, pos };
        const isP6 = rack === 'PASILLO 6';
        const rackCfg = this.data.racks.find(r=>r.name===rack);
        const targetCount = isP6 ? 34 : Math.max(2, rackCfg?.palletsPerRow || 2);
        const lc = isP6 ? 1 : Math.min(6, d.pallets.reduce((m,p)=>Math.max(m,...Object.keys(p.levels||{}).map(Number)),0)||3);
        while (d.pallets.length < targetCount) {
            const lvs = {};
            for (let i = 1; i <= lc; i++) lvs[i] = {occupied:false,reserved:false};
            d.pallets.push({free:true,product:null,levels:lvs});
        }
        if (this.tip && this.tip.rack===rack && this.tip.pos===pos && this.tip.cellIdx===cellIdx) {
            this.closeTip();
            return;
        }
        this._tipDragged = false;
        this.tip = { rack, pos, data: d, cellIdx };
        this._attachTipListeners();
        this.draw();
    }

    closeTip() {
        this.tip = null;
        this._detachTipListeners();
        this.draw();
    }

    // Hace arrastrable el tooltip desde su cabecera.
    _makeDraggable(tipEl) {
        const header = tipEl.querySelector('[data-wh-drag="true"]');
        if (!header) return;
        let isDragging = false;
        let startX, startY, origLeft, origTop;
        const onMouseDown = (e) => {
            if (e.target.closest('.btn-close')) return;
            isDragging = true;
            this._tipDragged = true;
            const rect = tipEl.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origLeft = rect.left;
            origTop = rect.top;
            tipEl.style.cursor = 'grabbing';
            header.style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };
        const onMouseMove = (e) => {
            if (!isDragging) return;
            tipEl.style.left = (origLeft + e.clientX - startX) + 'px';
            tipEl.style.top = (origTop + e.clientY - startY) + 'px';
        };
        const onMouseUp = () => {
            isDragging = false;
            tipEl.style.cursor = '';
            header.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        header.addEventListener('mousedown', onMouseDown);
    }

    // Coloca el tooltip junto a la celda seleccionada (o conserva su posición si se arrastró).
    _renderTooltip(el) {
        const oldTip = document.querySelector('.wh-tip-global');
        if (!this.tip) {
            if (oldTip) oldTip.remove();
            return;
        }
        const isP6 = this.tip.rack === 'PASILLO 6';
        const cell = isP6
            ? el.querySelector(`[data-rack="PASILLO 6"][data-row="${this.tip.pos}"]`)
            : el.querySelector(`[data-rack="${this.tip.rack}"][data-pos="${this.tip.pos}"]`);
        if (!cell) { if (oldTip) oldTip.remove(); return; }

        if (!oldTip) {
            const div = document.createElement('div');
            div.className = 'wh-tip-global';
            if (!this._tipDragged) {
                const r = cell.getBoundingClientRect();
                const tipW = 300, mg = 8;
                div.style.cssText = `position:fixed;z-index:9999;top:${Math.max(mg, r.top - 10)}px;left:${Math.max(mg, Math.min(r.right + 8, window.innerWidth - tipW - mg))}px`;
            } else {
                div.style.cssText = `position:fixed;z-index:9999`;
            }
            div.innerHTML = this._tipHtml();
            div.addEventListener('click', (ev) => {
                if (ev.target.closest('.btn-close')) this.closeTip();
            });
            document.body.appendChild(div);
            this._makeDraggable(div);
        } else {
            if (!this._tipDragged) {
                const r = cell.getBoundingClientRect();
                const tipW = 300, mg = 8;
                oldTip.style.top = Math.max(mg, r.top - 10) + 'px';
                oldTip.style.left = Math.max(mg, Math.min(r.right + 8, window.innerWidth - tipW - mg)) + 'px';
            }
            oldTip.innerHTML = this._tipHtml();
        }
    }

    // HTML interno del tooltip (tabla de pallets/niveles y edición).
    _tipHtml() {
        const t = this.tip;
        const rk = this.esc(t.rack), ps = t.pos;
        const cellLabel = t.cellIdx != null ? `-${z(t.cellIdx+1)}` : '';
        const isP6 = t.rack === 'PASILLO 6';
        const pallets = t.data.pallets||[];
        const palIdx = isP6 ? (t.cellIdx != null ? Math.min(t.cellIdx, pallets.length-1) : 0) : -1;

        let h = `<div class="card shadow-lg border-0" style="min-width:220px;max-width:280px;font-size:12px;border-radius:12px;max-height:90vh;overflow-y:auto;overflow-x:hidden">
            <div class="card-header bg-dark text-white py-2 px-3 d-flex justify-content-between align-items-center" style="border-bottom:none;border-radius:12px 12px 0 0;cursor:grab;user-select:none" data-wh-drag="true">
                <span class="fw-bold" style="font-size:12px"><i class="fa fa-arrows me-2 text-white-50" style="font-size:10px"></i>${rk} · ${z(ps)}${cellLabel}</span>
                <button class="btn-close btn-close-white" style="font-size:8px"></button>
            </div>
            <div class="card-body p-2">`;

        if (!isP6) {
            const ccId = t.data?.company_id;
            if (ccId && this.data?.companyColors?.[ccId]) {
                const cc = this.data.companyColors[ccId];
                h += `<div class="d-flex align-items-center gap-2 mb-2">
                    <span class="badge fw-normal" style="font-size:9px;background:${cc.color||'#6c757d'}1a;color:${cc.color||'#6c757d'};border:1px solid ${cc.color||'#6c757d'}44"><i class="fa fa-building-o me-1"></i>${this.esc(cc.name||('#'+ccId))}</span>
                    <span class="text-muted" style="font-size:9px">ocupa esta posición</span>
                </div>`;
            }
        }

        if (isP6) {
            const p = pallets[palIdx];
            const lc = Math.min(3, Math.max(1, p ? Object.keys(p.levels||{}).length : 1));
            h += `<table class="table table-sm mb-0" style="font-size:10px"><thead class="table-light"><tr><th class="text-muted fw-semibold" style="font-size:9px;border-top:none">#</th>`;
            for (let lv = 1; lv <= lc; lv++) {
                h += `<th class="text-center text-muted fw-semibold" style="font-size:9px;border-top:none">N${lv}${lv>1?` <button class="btn btn-sm btn-outline-danger py-0 px-1" style="font-size:7px;line-height:1;border-radius:2px" onclick="window._owh&&window._owh.removeLevel(${lv},event)">✕</button>`:""}</th>`;
            }
            h += `<th class="text-muted fw-semibold" style="font-size:9px;border-top:none">Producto</th>`;
            h += `<th style="width:18px;border-top:none"><button class="btn btn-sm btn-outline-secondary py-0 px-1" style="font-size:10px;line-height:1;border-radius:4px" onclick="window._owh&&window._owh.addLevel(event)">+</button></th>`;
            h += `</tr></thead><tbody>`;
            const lvl = (l) => p?.levels?.[l];
            const cellCls = (l) => lvl(l)?.occupied ? "text-danger fw-bold" : "text-muted";
            const cellVal = (l) => lvl(l)?.occupied ? "X" : "—";
            const cellBg = (l) => lvl(l)?.occupied ? "style=background:#fff5f5;cursor:pointer;border-radius:4px" : "style=cursor:pointer;border-radius:4px";
            h += `<tr><td class="fw-medium text-muted" style="font-size:9px">P1</td>`;
            for (let lv = 1; lv <= lc; lv++) {
                h += `<td class="text-center ${cellCls(lv)}" ${cellBg(lv)} onclick="window._owh&&window._owh.toggleLevel(${palIdx},${lv},event)">${cellVal(lv)}</td>`;
            }
            h += `<td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px">${this.esc(p?.product||"—")}</td>`;
            h += `<td class="text-center"></td>`;
            h += `</tr>`;
            h += `</tbody></table>`;
        } else {
            const lc = Math.min(6, pallets.reduce((m,p)=>Math.max(m,...Object.keys(p.levels||{}).map(Number)),0)||3);
            const hasLvls = pallets.some(p=>Object.keys(p.levels||{}).length);
            if (hasLvls) {
                h += `<table class="table table-sm mb-0" style="font-size:10px"><thead class="table-light"><tr><th class="text-muted fw-semibold" style="font-size:9px;border-top:none">#</th>`;
                for (let lv = 1; lv <= lc; lv++) {
                    h += `<th class="text-center text-muted fw-semibold" style="font-size:9px;border-top:none">N${lv}${lv>3?` <button class="btn btn-sm btn-outline-danger py-0 px-1" style="font-size:7px;line-height:1;border-radius:2px" onclick="window._owh&&window._owh.removeLevel(${lv},event)">✕</button>`:""}</th>`;
                }
                h += `<th class="text-muted fw-semibold" style="font-size:9px;border-top:none">Producto</th>`;
                h += `<th style="width:18px;border-top:none"><button class="btn btn-sm btn-outline-secondary py-0 px-1" style="font-size:10px;line-height:1;border-radius:4px" onclick="window._owh&&window._owh.addLevel(event)">+</button></th>`;
                h += `</tr></thead><tbody>`;
                for (let i = 0; i < pallets.length; i++) {
                    const p = pallets[i];
                    const lvl = (l) => p.levels?.[l];
                    const cellCls = (l) => lvl(l)?.occupied ? "text-danger fw-bold" : "text-muted";
                    const cellVal = (l) => lvl(l)?.occupied ? "X" : "—";
                    const cellBg = (l) => lvl(l)?.occupied ? "style=background:#fff5f5;cursor:pointer;border-radius:4px" : "style=cursor:pointer;border-radius:4px";
                    h += `<tr><td class="fw-medium text-muted" style="font-size:9px">P${i+1}</td>`;
                    for (let lv = 1; lv <= lc; lv++) {
                        h += `<td class="text-center ${cellCls(lv)}" ${cellBg(lv)} onclick="window._owh&&window._owh.toggleLevel(${i},${lv},event)">${cellVal(lv)}</td>`;
                    }
                    h += `<td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px">${this.esc(p.product||"—")}</td>`;
                    h += `<td class="text-center">${i>0?`<button class="btn btn-sm btn-outline-danger py-0 px-1" style="font-size:9px;line-height:1;border-radius:4px" onclick="window._owh&&window._owh.removePallet(${i},event)">✕</button>`:""}</td>`;
                    h += `</tr>`;
                }
                h += `<tr><td colspan="${lc+3}" class="text-center p-2" style="border-bottom:none">
                    <button class="btn btn-sm btn-outline-secondary py-1 px-3" style="font-size:11px;border-radius:8px" onclick="window._owh&&(window._owh.addPallet(event))">+ Añadir puesto</button>
                </td></tr>`;
                h += `</tbody></table>`;
            } else {
                h += `<div class="p-3 text-muted text-center" style="font-size:11px">${pallets.length||0} pallet(s)
                    <button class="btn btn-sm btn-outline-secondary ms-2 py-0 px-2" style="font-size:11px;border-radius:6px" onclick="window._owh&&(window._owh.addPallet(event))">+</button>
                </div>`;
            }
        }
        h += `</div></div>`;
        return h;
    }

    // Mantiene el tooltip pegado a su celda al hacer scroll.
    _attachTipListeners() {
        if (this._tipListenersAttached) return;
        this._tipListenersAttached = true;
        const el = this.root.el;
        if (!el) return;
        this._tipHandler = () => {
            if (this._tipDragged) return;
            const tipEl = document.querySelector('.wh-tip-global');
            if (!tipEl || !this.tip) return;
            const isP6 = this.tip.rack === 'PASILLO 6';
            const cell = isP6
                ? el.querySelector(`[data-rack="PASILLO 6"][data-row="${this.tip.pos}"]`)
                : el.querySelector(`[data-rack="${this.tip.rack}"][data-pos="${this.tip.pos}"]`);
            if (!cell) return;
            const r = cell.getBoundingClientRect();
            const tipW = 300, mg = 8;
            tipEl.style.top = Math.max(mg, r.top - 10) + 'px';
            tipEl.style.left = Math.max(mg, Math.min(r.right + 8, window.innerWidth - tipW - mg)) + 'px';
        };
        el.addEventListener('scroll', this._tipHandler, { capture: true, passive: true });
        this._tipClickHandler = (ev) => {
            if (!this.tip) return;
            const tipEl = document.querySelector('.wh-tip-global');
            if (tipEl && !tipEl.contains(ev.target)) {
                const cell = ev.target.closest('[data-rack]');
                if (!cell) this.closeTip();
            }
        };
        setTimeout(() => document.addEventListener('click', this._tipClickHandler), 0);
    }

    _detachTipListeners() {
        this._tipListenersAttached = false;
        const el = this.root.el;
        if (el && this._tipHandler) {
            el.removeEventListener('scroll', this._tipHandler, { capture: true });
        }
        if (this._tipClickHandler) {
            document.removeEventListener('click', this._tipClickHandler);
        }
        const tipEl = document.querySelector('.wh-tip-global');
        if (tipEl) tipEl.remove();
        this._tipHandler = null;
        this._tipClickHandler = null;
    }

    // Drag & drop para mover la ocupación entre celdas de racks.
    dragStart(ev) {
        const td = ev.target.closest('[data-rack]');
        if (!td) return;
        ev.dataTransfer.setData('text/plain', td.dataset.rack + '|' + td.dataset.pos);
        ev.dataTransfer.effectAllowed = 'move';
    }

    dragOver(ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
    }

    drop(ev) {
        ev.preventDefault();
        const target = ev.target.closest('[data-rack]');
        if (!target) return;
        const [srcRack, srcPos] = ev.dataTransfer.getData('text/plain').split('|');
        const srcPosN = parseInt(srcPos);
        const dstRack = target.dataset.rack;
        const dstPos = parseInt(target.dataset.pos);
        if (!srcRack || !dstRack || (srcRack === dstRack && srcPosN === dstPos)) return;
        if (srcRack === 'PASILLO 6' || dstRack === 'PASILLO 6') return;
        const occ = this.data?.occupancy;
        if (!occ?.[srcRack]?.[srcPosN] || !occ?.[dstRack]?.[dstPos]) return;
        if (occ[srcRack][srcPosN]?.isAisle || occ[dstRack][dstPos]?.isAisle) return;
        [occ[srcRack][srcPosN], occ[dstRack][dstPos]] = [occ[dstRack][dstPos], occ[srcRack][srcPosN]];
        this.tip = null;
        this._detachTipListeners();
        this._markDirty();
        this.draw();
    }

    // Marca la ocupación como modificada (muestra el botón Guardar).
    _markDirty() {
        this._dirty = true;
        this.recomputeStats();
    }

    // Alterna el estado ocupado/libre de un nivel en el tooltip.
    toggleLevel(palIdx, level, ev) {
        ev?.stopPropagation();
        if (!this.tip) return;
        const {rack,pos} = this.tip;
        const occ = this.data?.occupancy?.[rack]?.[pos];
        if (!occ) return;
        const pal = occ.pallets?.[palIdx];
        if (!pal) return;
        if (!pal.levels) pal.levels = {};
        if (!pal.levels[level]) pal.levels[level] = {occupied:false,reserved:false};
        const l = pal.levels[level];
        l.occupied = !l.occupied;
        l.reserved = false;
        pal.free = !occ.pallets.some(p => Object.values(p.levels||{}).some(lv=>lv.occupied));
        this._markDirty();
        this.draw();
    }

    addPallet(ev) {
        ev?.stopPropagation();
        if (!this.tip) return;
        const {rack,pos} = this.tip;
        if (rack === 'PASILLO 6') return this._tipWarn("Pasillo 6 tiene solo P1 fijo");
        const occ = this.data?.occupancy?.[rack]?.[pos];
        if (!occ) return;
        if (occ.pallets.length >= 6) return this._tipWarn("Máximo 6 pallets (P) por ubicación");
        const lc = occ.pallets.reduce((m,p)=>Math.max(m,...Object.keys(p.levels||{}).map(Number)),0)||3;
        const lvs = {};
        for (let i = 1; i <= lc; i++) lvs[i] = {occupied:false,reserved:false};
        occ.pallets.push({free:true,product:null,levels:lvs});
        this.tip.data = occ;
        this._markDirty();
        this.draw();
    }

    // Elimina un pallet del tooltip (PASILLO 6 no permite eliminar P1).
    removePallet(idx, ev) {
        ev?.stopPropagation();
        if (!this.tip) return;
        const {rack,pos} = this.tip;
        const occ = this.data?.occupancy?.[rack]?.[pos];
        if (!occ || idx <= 0 || idx >= occ.pallets.length) return;
        occ.pallets.splice(idx, 1);
        this.tip.data = occ;
        this._markDirty();
        this.draw();
    }

    // Añade un nivel nuevo al pallet (PASILLO 6 máx 3, racks máx 6).
    addLevel(ev) {
        ev?.stopPropagation();
        if (!this.tip) return;
        const {rack,pos,cellIdx} = this.tip;
        const occ = this.data?.occupancy?.[rack]?.[pos];
        if (!occ) return;
        const isP6 = rack === 'PASILLO 6';
        const maxLv = isP6 ? 3 : 6;
        const pal = isP6 ? occ.pallets[cellIdx] : null;
        const lc = isP6
            ? Math.max(0, ...Object.keys(pal?.levels||{}).map(Number))
            : occ.pallets.reduce((m,p)=>Math.max(m,...Object.keys(p.levels||{}).map(Number)),0);
        if (lc >= maxLv) return this._tipWarn(isP6 ? "Máximo 3 niveles (N) en Pasillo 6" : "Máximo 6 niveles (N) por pallet");
        const nxt = lc + 1;
        if (isP6) {
            if (!pal.levels) pal.levels = {};
            pal.levels[nxt] = {occupied:false,reserved:false};
        } else {
            for (const p of occ.pallets) {
                if (!p.levels) p.levels = {};
                p.levels[nxt] = {occupied:false,reserved:false};
            }
        }
        this.tip.data = occ;
        this._markDirty();
        this.draw();
    }

    // Elimina un nivel (el nivel 1 no se puede borrar).
    removeLevel(lv, ev) {
        ev?.stopPropagation();
        if (!this.tip) return;
        const {rack,pos,cellIdx} = this.tip;
        const occ = this.data?.occupancy?.[rack]?.[pos];
        if (!occ) return;
        const isP6 = rack === 'PASILLO 6';
        if (isP6) {
            if (lv <= 1) return;
            const pal = occ.pallets[cellIdx];
            if (pal?.levels) delete pal.levels[lv];
        } else {
            for (const pal of occ.pallets) {
                if (pal.levels) delete pal.levels[lv];
            }
        }
        this.tip.data = occ;
        this._markDirty();
        this.draw();
    }

    _tipWarn(msg) {
        const tipEl = document.querySelector('.wh-tip-global');
        if (!tipEl) return;
        const warn = document.createElement('div');
        warn.className = 'alert alert-warning py-1 px-2 mb-0 text-center rounded-0';
        warn.style.cssText = 'font-size:10px;margin:0;border-radius:0 0 12px 12px';
        warn.textContent = msg;
        const existing = tipEl.querySelector('.alert-warning');
        if (existing) existing.remove();
        tipEl.querySelector('.card-body')?.after(warn);
        setTimeout(() => warn.remove(), 2000);
    }

    // Guarda la ocupación manual en el servidor (ir.config_parameter).
    async saveChanges() {
        try {
            await rpc("/warehouse_map/save_occupancy", {
                warehouse_id: this.whId,
                occupancy: this.data.occupancy,
            });
            this._dirty = false;
            this.draw();
        } catch (e) {
            this.showError("Error al guardar: " + (e?.message || String(e)));
        }
    }

}

registry.category("actions").add("warehouse_map", WarehouseMap);
