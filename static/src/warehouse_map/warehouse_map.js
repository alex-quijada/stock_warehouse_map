import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";
import { Component, useRef, onMounted } from "@odoo/owl";

const C = {
    avail: "#22c55e", occup: "#ef4444", reserv: "#f97316",
    aisle: "#f1f5f9", cross: "#fef9c3",
    hdr: "#1e293b", hdrAisle: "#475569", hdrSpec: "#57534e",
};
function z(n) { return String(n).padStart(2,"0"); }

class WarehouseMap extends Component {
    static template = "stock_warehouse_map.WarehouseMapGrid";

    setup() {
        this.orm = useService("orm");
        this.root = useRef("root");
        this.whs = []; this.whId = null; this.data = null;
        this.tip = null; this.tipPos = null;
        onMounted(() => this.start());
    }

    async start() {
        try {
            this.whs = await this.orm.searchRead("stock.warehouse", [], ["name"]);
            if (this.whs.length) { this.whId = this.whs[0].id; await this.load(this.whs[0].id); }
            this.draw();
        } catch (e) { this.showError(e?.message); }
    }
    async load(id) {
        const r = await rpc("/warehouse_map/get_map_data", { warehouse_id: id });
        if (r.error) throw new Error(r.error);
        this.data = r;
    }
    async onWhChange(ev) {
        try {
            this.whId = parseInt(ev.target.value);
            this.tip = null;
            await this.load(this.whId); this.draw();
        } catch (e) {
            this.showError(e?.message || String(e));
        }
    }

    esc(s) { return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

    rackTitle(r) {
        if (r.type === "aisle") return "PASILLO " + r.name.replace("PASILLO ","");
        if (r.type === "special") return "PASILLO 6";
        return "RACK " + r.name.replace("RACK ","");
    }

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

    draw() {
        const el = this.root.el;
        if (!el) return;
        if (!this.whs.length) return this._msg("No hay almacenes configurados");
        if (!this.data) return this._msg("Cargando...", true);
        if (!this.data.racks) return this._msg("Sin datos de configuración");

        const { racks, occupancy, stats, pasillo6, companyColors } = this.data;
        const maxPos = racks.filter(r=>r.type==="rack").reduce((m,r)=>Math.max(m,r.totalPositions),0);
        const cW = 64;
        const dS = 8;
        const dG = 4;

        /* ---- generate pasillo 6 visual once (if present) ---- */
        let p6Html = '';
        if (pasillo6) {
            const P = {
                red: '#ef4444', green: '#22c55e', gray: '#94a3b8',
                yellow: '#fef08a',
            };
            const CS = 14, RH = 24, BB = '#e2e8f0';
            const cx = (x) => {
                const bg = typeof x==='string'?x:x.c;
                const ext = typeof x==='object'?x.ext:'';
                return `<div style="width:${CS}px;height:${RH}px;border:1px solid ${BB};background:${bg};flex-shrink:0${ext?';'+ext:''}"></div>`;
            };
            const row = (clr, n) => {let r='<div style="display:flex">';for(let i=0;i<n;i++)r+=cx(typeof clr==='string'?clr:clr[i]);return r+'</div>';};
            const col = (arr, n) => arr.map(c => c==='SP' ? `<div style="height:${RH-2}px;flex-shrink:0"></div>` : row(c||'transparent', n)).join('');

            const b1L = Array(14).fill(P.red), b1R = Array(14).fill(P.red);
            const b2L = [P.red, P.red, P.red, 'SP', P.red, P.red, P.red];
            const b2R = [P.red, P.red, P.red, 'SP', P.red, P.red, P.red];
            const b3L = Array(14).fill(P.green), b3R = Array(14).fill(P.green);
            const b4L = Array(6).fill(P.gray), b4R = Array(6).fill(P.green);

            const blk = (larr, rarr, opts) => {
                const lc = 6, rc = 12;
                return `<div style="display:flex;gap:0">
                    <div style="display:flex;flex-direction:column;width:${(CS+2)*lc}px">${col(larr,lc)}</div>
                    <div style="width:36px;flex-shrink:0;display:flex;align-items:center;justify-content:center">${opts?.center||''}</div>
                    <div style="display:flex;flex-direction:column;width:${(CS+2)*rc}px">${col(rarr,rc)}</div>
                </div>`;
            };
            const crossBar = () => {
                const w = (CS+2)*6, w2 = (CS+2)*12;
                return `<div style="display:flex;gap:0;height:${RH}px;flex-shrink:0;border:1px solid ${BB};background:${C.cross}">
                    <div style="width:${w}px;display:flex;align-items:center;padding:0 6px;border-right:1px solid ${BB}"><span style="font-size:9px;color:#a78bfa;font-weight:600">⇄</span></div>
                    <div style="width:36px;flex-shrink:0"></div>
                    <div style="width:${w2}px;display:flex;align-items:center;padding:0 6px;border-left:1px solid ${BB}"><span style="font-size:9px;color:#a78bfa;font-weight:600">⇄</span></div>
                </div>`;
            };

            const b3Last = Array(6).fill(P.green);
            b3Last[5] = {c:P.yellow, ext:'margin-right:-4px;position:relative;z-index:2'};

            let ph = '';
            ph += blk(b1L, b1R);
            ph += crossBar();
            ph += blk(b2L, b2R);
            ph += blk([...b3L.slice(0,-1), b3Last], b3R, {
                center: `<span style="writing-mode:vertical-rl;font-size:8px;font-weight:600;color:#9ca3af;letter-spacing:1px">1.081 mts²</span>`,
            });
            ph += crossBar();
            ph += blk(b4L, b4R);
            p6Html = ph;
        }

        let h = "";

        /* ===== TOP BAR ===== */
        h += `<div class="d-flex align-items-center gap-2 px-3 pt-3 pb-2 flex-wrap" style="flex-shrink:0">
            <label class="text-muted small fw-semibold text-uppercase" style="font-size:11px;letter-spacing:.5px">Almacén</label>
            <select class="form-select form-select-sm border-0 bg-light fw-semibold" style="width:auto;min-width:150px;box-shadow:0 1px 2px rgba(0,0,0,.05);font-size:13px;border-radius:8px">`;
        for (const w of this.whs) h += `<option value="${w.id}"${w.id===this.whId?" selected":""}>${this.esc(w.name)}</option>`;
        h += `</select>`;
        if (stats) {
            h += `<div class="d-flex gap-1 ms-auto flex-wrap">
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#e8f5e9;color:#2e7d32;font-size:11px"><i class="fa fa-circle-o text-success me-1"></i>${stats.free} libres</span>
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#ffebee;color:#c62828;font-size:11px"><i class="fa fa-check-circle text-danger me-1"></i>${stats.occupied} ocupadas</span>
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#e3f2fd;color:#1565c0;font-size:11px"><i class="fa fa-cubes text-primary me-1"></i>${stats.total} total</span>
                <span class="badge rounded-pill fw-normal px-3 py-2" style="background:#f3e5f5;color:#6a1b9a;font-size:11px"><i class="fa fa-percent me-1"></i>${stats.percentage}%</span>
            </div>`;
        }
        h += `</div>`;

        /* ===== LEGEND ===== */
        h += `<div class="d-flex flex-wrap align-items-center gap-3 px-3 pb-3 small text-muted" style="flex-shrink:0">`;
        const leg = (bg,label) => `<span class="d-inline-flex align-items-center gap-1"><span class="d-inline-block rounded" style="width:12px;height:12px;background:${bg}"></span>${label}</span>`;
        h += leg(C.avail,"Disponible")+leg(C.occup,"Ocupado")+leg(C.reserv,"Reservado")+leg(C.aisle,"Pasillo")+leg(C.cross,"Cruce");
        h += `</div>`;

        /* ===== BODY ===== */
        h += `<div class="d-flex flex-grow-1" style="min-height:0">`;

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
                    h += `<td style="background:${C.aisle};padding:0;text-align:center;font-size:7px;color:#94a3b8;border:1px solid #e2e8f0">${isCross?"⇄":""}</td>`;
                } else if (r.type==="special") {
                    if (p === 1) h += `<td rowspan="${maxPos}" style="padding:2px;border:1px solid #e2e8f0;background:#fff;vertical-align:top;overflow:visible">${p6Html}</td>`;
                    continue;
                } else if (p > r.totalPositions) {
                    h += `<td style="background:#fafafa;padding:0;border:1px solid #e2e8f0"></td>`;
                } else {
                    const o = occupancy?.[r.name]?.[p];
                    const status = this.posStatus(r.name, p);

                    if (o?.isAisle) {
                        h += `<td style="background:${C.aisle};padding:0;text-align:center;font-size:7px;color:#94a3b8;border:1px solid #e2e8f0">${isCross?"⇄":"│"}</td>`;
                    } else {
                        const lvs = r.totalLevels||3;

                        /* Same HTML order for ALL racks: label, pipe, dots.
                         * CSS `order` reorders visually for B,D,F (■■■|B01). */
                        const rl = r.name.replace("RACK ","");
                        const inv = r.name==="RACK B"||r.name==="RACK D"||r.name==="RACK F";
                        const lo = inv ? 3 : 1, po = 2, zo = inv ? 1 : 3;
                        let dots = `<div style="display:flex;flex-direction:column;gap:3px">`;
                        for (let sl = 0; sl <= 1; sl++) {
                            const label = sl===0
                                ? `<span style="display:inline-block;font-size:7px;font-weight:700;color:#94a3b8;line-height:8px;width:20px;text-align:center;overflow:hidden;order:${lo}">${rl}${z(p)}</span>`
                                : `<span style="display:inline-block;width:20px;order:${lo}"></span>`;
                            const pipe = `<span style="font-size:7px;color:#94a3b8;line-height:8px;order:${po}">|</span>`;
                            let dhtml = "";
                            for (let lv = 1; lv <= lvs; lv++) {
                                const c = this.dotColor(r.name, p, sl, lv)||C.avail;
                                dhtml += `<div style="width:${dS}px;height:${dS}px;background:${c};border-radius:1px;flex-shrink:0;order:${zo}"></div>`;
                            }
                            dots += `<div style="display:flex;gap:2px;align-items:center;justify-content:center">${label}${pipe}${dhtml}</div>`;
                        }
                        dots += `</div>`;

                        h += `<td class="wh-cell${status==="occupied"||status==="reserved"?" has-stock":""}"
                            style="height:24px;padding:2px 2px;text-align:center;cursor:pointer;border:1px solid #e2e8f0;background:#fff;vertical-align:middle"
                            data-rack="${this.esc(r.name)}" data-pos="${p}"
                            onclick="var d=this.dataset;window._owh&&window._owh.toggleTip(d.rack,parseInt(d.pos),event)">${dots}</td>`;
                    }
                }
            }
            h += `</tr>`;
        }
        h += `</tbody></table>`;

        h += `</div>`;

        /* ===== SIDEBAR ===== */
        if (pasillo6) {
            h += `<div class="border-start bg-light p-3" style="width:280px;overflow-y:auto;flex-shrink:0">
                <div class="d-flex align-items-center gap-2 mb-3">
                    <span class="badge bg-dark fw-bold" style="font-size:10px;padding:4px 10px;letter-spacing:.5px">PASILLO 6</span>
                </div>
                <div class="d-flex gap-2 mb-3 flex-wrap">
                    <span class="badge bg-success fw-normal" style="font-size:11px">${pasillo6.occupied} ocup</span>
                    <span class="badge bg-secondary fw-normal" style="font-size:11px">${pasillo6.free} libre</span>
                    <span class="badge bg-primary fw-normal" style="font-size:11px">${pasillo6.total}</span>
                </div>
                <div class="progress mb-3 rounded-pill" style="height:20px;background:#e2e8f0"><div class="progress-bar bg-success rounded-pill fw-bold d-flex align-items-center justify-content-center" style="width:${pasillo6.percentage}%;font-size:10px">${pasillo6.percentage}%</div></div>
                <div style="max-height:360px;overflow-y:auto">`;
            for (const g of (pasillo6.companyGroups||[])) {
                const nm = g.company_id?(companyColors?.[g.company_id]?.name||"#"+g.company_id):"Sin empresa";
                const c = g.company_id&&companyColors?.[g.company_id]?.color||"#6c757d";
                h += `<div class="mb-2"><div class="d-flex justify-content-between small mb-1"><span class="fw-medium" style="font-size:11px">${this.esc(nm)}</span><span class="text-muted" style="font-size:10px">${g.occupied}/${g.total}</span></div>
                    <div class="progress rounded-pill" style="height:6px;background:#e2e8f0"><div class="progress-bar rounded-pill" style="width:${g.percentage}%;background:${c}"></div></div></div>`;
            }
            h += `</div></div>`;
        }

        h += `</div>`;

        /* ===== TOOLTIP ===== */
        if (this.tip && this.tipPos) {
            const t = this.tip;
            h += `<div style="position:fixed;z-index:9999;top:${Math.max(0,this.tipPos.y-10)}px;left:${Math.min(window.innerWidth-320,this.tipPos.x+15)}px">
                <div class="card shadow border-0" style="min-width:220px;max-width:300px;font-size:12px;border-radius:10px">
                    <div class="card-header bg-dark text-white py-2 px-3 d-flex justify-content-between align-items-center rounded-top" style="border-bottom:none">
                        <span class="fw-bold" style="font-size:12px">${this.esc(t.rack)} · ${z(t.pos)}</span>
                        <button class="btn-close btn-close-white" style="font-size:8px" onclick="window._owh&&(window._owh.tip=null,window._owh.tipPos=null,window._owh.draw())"></button>
                    </div>
                    <div class="card-body p-0">`;
            const hasLvls = t.data.pallets?.some(p=>Object.keys(p.levels||{}).length);
            if (hasLvls) {
                h += `<table class="table table-sm mb-0" style="font-size:10px"><thead class="table-light"><tr><th class="text-muted fw-semibold" style="font-size:9px">#</th><th class="text-center text-muted fw-semibold" style="font-size:9px">N1</th><th class="text-center text-muted fw-semibold" style="font-size:9px">N2</th><th class="text-center text-muted fw-semibold" style="font-size:9px">N3</th><th class="text-muted fw-semibold" style="font-size:9px">Producto</th></tr></thead><tbody>`;
                for (let i = 0; i < (t.data.pallets||[]).length; i++) {
                    const p = t.data.pallets[i];
                    const cls = (l) => p.levels?.[l]?.occupied ? "text-danger fw-bold" : p.levels?.[l]?.reserved ? "text-warning fw-bold" : "text-muted";
                    const val = (l) => p.levels?.[l]?.occupied ? "X" : p.levels?.[l]?.reserved ? "R" : "—";
                    h += `<tr><td class="fw-medium text-muted">P${i+1}</td><td class="text-center ${cls(1)}">${val(1)}</td><td class="text-center ${cls(2)}">${val(2)}</td><td class="text-center ${cls(3)}">${val(3)}</td><td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(p.product||"—")}</td></tr>`;
                }
                h += `</tbody></table>`;
            } else {
                h += `<div class="p-3 text-muted" style="font-size:11px">${t.data.pallets?.length||0} pallet(s)</div>`;
            }
            h += `</div></div></div>`;
        }

        el.innerHTML = h;
        window._owh = this;
        const sel = el.querySelector("select");
        if (sel) sel.onchange = (ev) => this.onWhChange(ev);
    }

    _msg(text, spin) {
        const el = this.root.el;
        if (!el) return;
        el.innerHTML = `<div class="d-flex align-items-center justify-content-center h-100"><div class="text-center text-muted">${spin?`<div class="spinner-border text-primary mb-3" role="status"></div>`:""}<div>${this.esc(text)}</div></div></div>`;
    }

    toggleTip(rack, pos, ev) {
        const d = this.data?.occupancy?.[rack]?.[pos];
        if (!d?.pallets) return;
        if (this.tip && this.tip.rack===rack && this.tip.pos===pos) { this.tip=null; this.tipPos=null; }
        else { this.tip={rack,pos,data:d}; this.tipPos={x:ev?.clientX||0,y:ev?.clientY||0}; }
        this.draw();
    }

}

registry.category("actions").add("warehouse_map", WarehouseMap);
