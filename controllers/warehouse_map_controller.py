import io
import re
import xlsxwriter
from odoo import http
from odoo.http import request
from collections import defaultdict


class WarehouseMapController(http.Controller):
    """Controlador HTTP/JSON-RPC del Mapa Virtual del Almacén.

    Endpoints:
        /warehouse_map/get_map_data        -> datos de racks + ocupación (JSON-RPC)
        /warehouse_map/get_warehouses      -> almacenes del usuario (JSON-RPC)
        /warehouse_map/save_occupancy      -> guarda edición manual (JSON-RPC)
        /warehouse_map/save_company_colors -> persiste colores de empresa (JSON-RPC)
        /warehouse_map/export_excel        -> exporta el mapa a .xlsx (HTTP)
    """

    @http.route('/warehouse_map/get_map_data', type='jsonrpc', auth='user')
    def get_map_data(self, warehouse_id):
        """Devuelve todo lo necesario para dibujar el mapa de un almacén.

        :param warehouse_id: id de `stock.warehouse`.
        :return: dict con 'racks', 'occupancy', 'stats' y 'companyColors'.
        """
        warehouse = request.env['stock.warehouse'].sudo().browse(warehouse_id)
        if not warehouse.exists():
            return {'error': 'Almacén no encontrado'}

        # Solo los almacenes físicos (con ubicación interna) tienen mapa 2D.
        internal_locations = request.env['stock.location'].sudo().search([
            ('warehouse_id', '=', warehouse.id),
            ('usage', '=', 'internal'),
        ], limit=1)
        if not internal_locations:
            return {'error': 'Este es un almacén no físico, no puede haber mapa 2D'}

        # Mapa propio del almacén; el almacén "principal" cae al mapa global.
        maps = request.env['warehouse.map'].sudo().search([('warehouse_id', '=', warehouse_id)])
        if not maps and 'principal' in warehouse.name.lower():
            maps = request.env['warehouse.map'].sudo().search([('warehouse_id', '=', False)], limit=1)
        if not maps:
            return {'error': 'No hay configuración de mapa para este almacén'}

        wh_map = maps[0]
        racks = wh_map.rack_ids

        # Metadatos por rack: el frontend los usa para dibujar la grilla.
        rack_data = []
        for rack in racks:
            assigned_companies = rack.company_ids
            rack_info = {
                'id': rack.id,
                'name': rack.name,
                'type': rack.rack_type,          # 'rack' | 'aisle' | 'special'
                'totalPositions': rack.total_positions,
                'totalLevels': rack.total_levels,
                'aislePositions': [int(x.strip()) for x in rack.aisle_positions.split(',') if x.strip()] if rack.aisle_positions else [],
                'palletsPerRow': rack.pallets_per_row,
                'hasFrontBack': rack.has_front_back,
                'capacity': rack.capacity,
                'capacityNote': rack.capacity_note or '',
                'companyIds': assigned_companies.ids if assigned_companies else [],
            }
            rack_data.append(rack_info)

        occupancy = self._compute_occupancy(warehouse, racks)
        stats = self._compute_stats(rack_data, occupancy)
        company_colors = self._get_company_colors(wh_map)

        # Edición manual guardada previamente: sobreescribe lo calculado.
        # Clave ir.config_parameter: 'warehouse_map.occupancy.{warehouse_id}'.
        overrides_raw = request.env['ir.config_parameter'].sudo().get_param(f'warehouse_map.occupancy.{warehouse_id}')
        if overrides_raw:
            import json
            overrides = json.loads(overrides_raw)
            for rname, rdata in overrides.items():
                if rname in occupancy:
                    for pos, pdata in rdata.items():
                        occupancy[rname][int(pos)] = pdata

        return {
            'racks': rack_data,
            'occupancy': occupancy,
            'stats': stats,
            'companyColors': company_colors,
        }

    def _get_company_colors(self, wh_map):
        """Color por empresa (res.company.map_color) para pintar la ocupación."""
        companies = request.env['res.company'].sudo().search([])
        colors = {}
        for c in companies:
            colors[c.id] = {
                'name': c.name,
                'color': c.map_color or '#2196F3',
            }
        return colors

    RACK_NAME_RE = re.compile(r'^RACK ([A-I])(\d+)-(\d+)$')
    PASILLO6_NAME_RE = re.compile(r'^PILAR B(\d+) - ([AB])(\d+)-(\d+)$')

    def _aisle_positions(self, rack):
        return [int(x.strip()) for x in rack.aisle_positions.split(',') if x.strip()] if rack.aisle_positions else []

    def _grid_row(self, pair_index):
        return pair_index + (1 if pair_index >= 15 else 0) + (1 if pair_index >= 36 else 0)

    def _parse_rack_location(self, loc):
        m = self.RACK_NAME_RE.match(loc.name or '')
        if not m:
            return None
        return m.group(1), int(m.group(2)), int(m.group(3))

    def _compute_occupancy(self, warehouse, racks):
        """Calcula la ocupación real de cada rack desde las ubicaciones y quants.

        Para cada rack de tipo 'rack' busca sus ubicaciones internas bajo
        ``{Stock del almacén}/RACK X/``, lee los stock.quant y agrupa por
        posición/nivel. Los pasillos ('aisle') se saltan y el PASILLO 6
        ('special') se genera como grilla decorativa vacía.
        """
        occupancy = {}
        for rack in racks:
            if rack.rack_type == 'aisle':
                continue
            # Buscar en TODAS las empresas: cada empresa tiene su propio árbol
            # bajo PR01/Stock con el mismo prefijo, así que quitamos el filtro
            # por warehouse_id para pintar en rojo lo que ocupan las demás.
            # El prefijo se ancla al Stock de este almacén para no traer árboles
            # de otros almacenes (PR02, PR03, TCGM, TC01...) que comparten nombre.
            stock_root = request.env['stock.location'].sudo().search([
                ('warehouse_id', '=', warehouse.id),
                ('name', '=', 'Stock'),
            ], limit=1)
            prefix = (stock_root.complete_name or warehouse.name).rstrip('/')

            if rack.rack_type == 'special':
                # PASILLO 6: esquema decorativo (aún sin mapear a ubicaciones reales).
                # La grilla dibuja el pasillo completo con celdas libres; cada
                # posición tiene un conjunto de pallets que el frontend agrupa.
                rack_occ = {}
                for grid_pos in range(1, rack.total_positions + 1):
                    pallets = []
                    for pallet_idx in range(rack.pallets_per_row):
                        pallets.append({
                            'free': True,
                            'product': None,
                            'levels': {},
                            'locId': None,
                            'company_id': False,
                        })
                    rack_occ[grid_pos] = {
                        'pallets': pallets,
                        'product': None,
                        'company_id': False,
                    }
                occupancy[rack.name] = rack_occ
                continue

            # Ubicaciones internas reales del rack (todas las empresas).
            rack_locations = request.env['stock.location'].sudo().search([
                ('complete_name', '=ilike', f'{prefix}/{rack.name}/%'),
                ('usage', '=', 'internal'),
            ])

            # Quants con stock > 0, agregados por ubicación.
            quants = request.env['stock.quant'].sudo().search([
                ('location_id', 'in', rack_locations.ids),
                ('quantity', '>', 0),
            ])
            qty_by_loc = defaultdict(float)
            reserved_by_loc = defaultdict(float)
            quants_by_loc = defaultdict(list)
            for q in quants:
                qty_by_loc[q.location_id.id] += q.quantity
                reserved_by_loc[q.location_id.id] += q.reserved_quantity
                quants_by_loc[q.location_id.id].append(q)

            aisle_positions = set(self._aisle_positions(rack))
            rack_occ = {}

            # Agrupar ubicaciones por (rack_letter, pos_name, level), ignorando
            # duplicados de RACK D (copias idénticas del mismo nombre y empresa).
            # Como varias empresas comparten el mismo nombre, se guarda una por
            # empresa y luego se agrega el stock de todas.
            by_key = defaultdict(list)
            seen = set()
            for loc in rack_locations:
                parsed = self._parse_rack_location(loc)
                if not parsed:
                    continue
                cid = loc.company_id.id or 0
                ckey = parsed + (cid,)
                if ckey in seen:
                    continue
                seen.add(ckey)
                by_key[parsed].append(loc)

            for grid_pos in range(1, rack.total_positions + 1):
                if grid_pos in aisle_positions:
                    rack_occ[grid_pos] = {'pallets': [], 'product': None, 'company_id': None, 'isAisle': True}
                    continue

                # Cada celda de la grilla = 2 posiciones consecutivas (2N-1, 2N) x 3 niveles.
                # El par N se cuenta saltando las filas de pasillo (15 y 37).
                pair_index = grid_pos - (1 if grid_pos > 15 else 0) - (1 if grid_pos > 37 else 0)
                pallet_positions = (2 * pair_index - 1, 2 * pair_index)
                rack_letter = rack.name.replace('RACK ', '')
                pallets = []
                company_id = False

                for pallet_idx, pos_name in enumerate(pallet_positions, start=1):
                    levels_data = {}
                    first_loc = False
                    for level_num in range(1, rack.total_levels + 1):
                        locs = by_key.get((rack_letter, pos_name, level_num)) or []
                        total_qty = sum(qty_by_loc.get(l.id, 0) for l in locs)
                        reserved_qty = sum(reserved_by_loc.get(l.id, 0) for l in locs)
                        occ_locs = [l for l in locs if qty_by_loc.get(l.id, 0) > 0]
                        occ_loc = occ_locs[0] if occ_locs else None

                        if not first_loc and locs:
                            first_loc = locs[0]

                        loc_company_id = occ_loc.company_id.id or False if occ_loc else False
                        if loc_company_id and not company_id:
                            company_id = loc_company_id

                        # Agrupa productos por display_name, sumando cantidades.
                        products = []
                        products_by_name = {}
                        for l in occ_locs:
                            cid = l.company_id.id or False
                            for q in quants_by_loc.get(l.id, []):
                                pname = q.product_id.display_name
                                entry = products_by_name.get(pname)
                                if entry is None:
                                    entry = {
                                        'name': pname,
                                        'qty': q.quantity,
                                        'uom': q.product_uom_id.name or '',
                                        'lot': q.lot_id.name if q.lot_id else None,
                                        'company_id': cid,
                                    }
                                    products_by_name[pname] = entry
                                    products.append(entry)
                                else:
                                    entry['qty'] += q.quantity
                                    entry['lot'] = entry['lot'] or (q.lot_id.name if q.lot_id else None)

                        levels_data[level_num] = {
                            'occupied': bool(total_qty > 0),
                            'reserved': bool(reserved_qty >= total_qty > 0),
                            'product': products[0]['name'] if products else False,
                            'products': products,
                            'qty': total_qty,
                            'company_id': loc_company_id,
                            'complete_name': occ_loc.complete_name if occ_loc else False,
                        }

                    pallet_occupied = any(ld['occupied'] for ld in levels_data.values())
                    pallets.append({
                        'free': not pallet_occupied,
                        'product': next((ld['product'] for ld in levels_data.values() if ld['product']), None),
                        'levels': levels_data,
                        'locId': first_loc.id if first_loc else None,
                        'company_id': next((ld['company_id'] for ld in levels_data.values() if ld['company_id']), False),
                        'tooltipData': {
                            'id': first_loc.id if first_loc else None,
                            'name': f'{rack_letter}{pos_name:02d}-{level_num}' if first_loc else '',
                            'product': next((ld['product'] for ld in levels_data.values() if ld['product']), None),
                            'qty': total_qty if first_loc else 0,
                        } if first_loc else None,
                    })

                rack_occ[grid_pos] = {
                    'pallets': pallets,
                    'product': next((p['product'] for p in pallets if p['product']), None),
                    'company_id': company_id,
                }

            occupancy[rack.name] = rack_occ

        return occupancy

    def _compute_stats(self, racks, occupancy):
        """Cuenta pallets totales y ocupados (solo racks tipo 'rack')."""
        total = 0
        occupied = 0
        for rack in racks:
            if rack['type'] != 'rack':
                continue
            rack_occ = occupancy.get(rack['name'], {})
            for pos, data in rack_occ.items():
                if data.get('isAisle'):
                    continue
                for pallet in data.get('pallets', []):
                    total += 1
                    if not pallet['free']:
                        occupied += 1

        free = total - occupied
        percentage = round((occupied / total * 100) if total else 0, 1)
        return {
            'total': total,
            'free': free,
            'occupied': occupied,
            'percentage': percentage,
        }

    @http.route('/warehouse_map/export_excel', type='http', auth='user')
    def export_excel(self, warehouse_id):
        """Exporta el mapa a un .xlsx con la ocupación actual por rack.

        Fila 0: cabecera (POS + nombre de rack). Filas 1..43: cada fila de la
        grilla con una celda por pallet, coloreada según ocupación.
        """
        warehouse = request.env['stock.warehouse'].browse(int(warehouse_id))
        if not warehouse.exists():
            return request.not_found()

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        worksheet = workbook.add_worksheet('Mapa del Almacén')

        header_fmt = workbook.add_format({
            'bold': True, 'bg_color': '#1a237e', 'font_color': 'white',
            'border': 1, 'text_wrap': True, 'valign': 'vcenter', 'align': 'center',
        })
        free_fmt = workbook.add_format({
            'bg_color': '#c8e6c9', 'border': 1, 'align': 'center', 'valign': 'vcenter',
        })
        occ_fmt = workbook.add_format({
            'bg_color': '#ffcdd2', 'border': 1, 'align': 'center', 'valign': 'vcenter',
        })
        aisle_fmt = workbook.add_format({
            'bg_color': '#e8eaf6', 'border': 1, 'align': 'center', 'valign': 'vcenter',
        })
        cross_fmt = workbook.add_format({
            'bg_color': '#fff3e0', 'border': 1, 'align': 'center', 'valign': 'vcenter',
        })
        pos_fmt = workbook.add_format({
            'bold': True, 'bg_color': '#f5f5f5', 'border': 1,
            'align': 'center', 'valign': 'vcenter',
        })
        cap_fmt = workbook.add_format({
            'bold': True, 'bg_color': '#e8eaf6', 'border': 1,
            'align': 'center', 'valign': 'vcenter', 'font_size': 10,
        })

        maps = request.env['warehouse.map'].search([('warehouse_id', '=', warehouse.id)])
        if not maps:
            maps = request.env['warehouse.map'].search([('warehouse_id', '=', False)], limit=1)
        if not maps:
            return request.not_found()

        wh_map = maps[0]
        # El PASILLO 6 (special) no se exporta.
        racks = wh_map.rack_ids.filtered(lambda r: r.rack_type != 'special')

        col = 0
        worksheet.write(0, col, 'POS', header_fmt)
        col += 1
        rack_cols = {}
        for rack in racks:
            span = max(rack.pallets_per_row, 1)
            rack_cols[rack.id] = (col, span)
            worksheet.merge_range(0, col, 0, col + span - 1, rack.name, header_fmt)
            col += span

        total_cols = col
        worksheet.set_column(0, 0, 5)
        for c in range(1, total_cols):
            worksheet.set_column(c, c, 4)

        for row in range(1, 44):
            is_cross = row in (15, 37)
            worksheet.write(row, 0, '' if is_cross else str(row).zfill(2), pos_fmt)
            col = 1
            for rack in racks:
                span = max(rack.pallets_per_row, 1)
                if rack.rack_type == 'aisle':
                    for p in range(span):
                        fmt = cross_fmt if is_cross else aisle_fmt
                        worksheet.write(row, col + p, '' if not is_cross else '\u2194', fmt)
                else:
                    if is_cross:
                        for p in range(span):
                            worksheet.write(row, col + p, '\u2194', cross_fmt)
                    elif row <= rack.total_positions:
                        occ_data = {}
                        rack_loc = request.env['stock.location'].search([
                            ('complete_name', '=ilike', f'%/{rack.name}/%'),
                            ('warehouse_id', '=', warehouse.id),
                            ('usage', '=', 'internal'),
                        ])
                        for loc in rack_loc:
                            qty = sum(loc.quant_ids.mapped('quantity'))
                            if qty > 0 and loc.map_position == row:
                                occ_data['front'] = qty
                            elif qty > 0 and loc.map_pos_y == row:
                                occ_data['front'] = qty
                        for p in range(span):
                            occupied = bool(occ_data)
                            worksheet.write(row, col + p, 'X' if occupied else '', occ_fmt if occupied else free_fmt)
                    else:
                        for p in range(span):
                            worksheet.write(row, col + p, '', workbook.add_format())
                col += span

        workbook.close()
        output.seek(0)
        return request.make_response(
            output.getvalue(),
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', f'attachment; filename=mapa_{warehouse.code}.xlsx'),
            ],
        )

    @http.route('/warehouse_map/get_warehouses', type='jsonrpc', auth='user')
    def get_warehouses(self):
        """Almacenes visibles para la empresa activa del usuario.

        Lee la cookie 'cids' (empresas activas). Marca como principal el
        almacén con código PR01 (o cuyo nombre contenga 'principal').
        """
        cids = request.cookies.get('cids', str(request.env.user.company_id.id))
        company_ids = [int(cid) for cid in cids.split('-') if cid.strip().isdigit()]
        current_company_id = company_ids[0] if company_ids else request.env.user.company_id.id
        whs = request.env['stock.warehouse'].sudo().search([
            ('company_id', '=', current_company_id),
        ], order='id asc')
        main_wh = whs.filtered(lambda w: w.code == 'PR01')[:1]
        if not main_wh:
            main_wh = whs.filtered(lambda w: 'principal' in w.name.lower())[:1]
        return {
            'warehouses': [{'id': w.id, 'name': w.name, 'code': w.code} for w in whs],
            'main_warehouse_id': main_wh.id if main_wh else False,
        }

    @http.route('/warehouse_map/save_occupancy', type='jsonrpc', auth='user')
    def save_occupancy(self, warehouse_id, occupancy):
        """Guarda la ocupación manual (edición del tooltip / drag&drop).

        Se persiste como JSON en ir.config_parameter bajo la clave
        'warehouse_map.occupancy.{warehouse_id}'. Al cargar el mapa, este
        valor sobreescribe la ocupación calculada (ver get_map_data).
        """
        import json
        request.env['ir.config_parameter'].sudo().set_param(
            f'warehouse_map.occupancy.{warehouse_id}',
            json.dumps(occupancy, default=str)
        )
        return {'success': True}

    @http.route('/warehouse_map/save_company_colors', type='jsonrpc', auth='user')
    def save_company_colors(self, colors):
        """Persiste el color del mapa de cada empresa (res.company.map_color)."""
        for color_data in colors:
            company = request.env['res.company'].browse(color_data['id'])
            if company.exists():
                company.write({'map_color': color_data['color']})
        return {'success': True}
