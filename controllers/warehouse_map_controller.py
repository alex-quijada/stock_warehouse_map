import io
import xlsxwriter
from odoo import http
from odoo.http import request
from collections import defaultdict


class WarehouseMapController(http.Controller):

    @http.route('/warehouse_map/get_map_data', type='jsonrpc', auth='user')
    def get_map_data(self, warehouse_id):
        warehouse = request.env['stock.warehouse'].browse(warehouse_id)
        if not warehouse.exists():
            return {'error': 'Almacén no encontrado'}

        maps = request.env['warehouse.map'].search([('warehouse_id', '=', warehouse_id)])
        if not maps:
            maps = request.env['warehouse.map'].search([('warehouse_id', '=', False)], limit=1)
        if not maps:
            return {'error': 'No hay configuración de mapa para este almacén'}

        wh_map = maps[0]
        racks = wh_map.rack_ids

        rack_data = []
        pasillo6_data = None

        for rack in racks:
            assigned_companies = rack.company_ids
            rack_info = {
                'id': rack.id,
                'name': rack.name,
                'type': rack.rack_type,
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

            if rack.rack_type == 'special':
                pasillo6_data = self._compute_pasillo6_occupancy(warehouse, rack)

        occupancy = self._compute_occupancy(warehouse, racks)
        stats = self._compute_stats(rack_data, occupancy)
        company_colors = self._get_company_colors(wh_map)

        return {
            'racks': rack_data,
            'occupancy': occupancy,
            'stats': stats,
            'pasillo6': pasillo6_data,
            'companyColors': company_colors,
        }

    def _get_company_colors(self, wh_map):
        companies = request.env['res.company'].search([])
        colors = {}
        for c in companies:
            colors[c.id] = {
                'name': c.name,
                'color': c.map_color or '#2196F3',
            }
        return colors

    def _compute_pasillo6_occupancy(self, warehouse, rack):
        locations = request.env['stock.location'].search([
            ('complete_name', '=ilike', f'%/{rack.name}/%'),
            ('warehouse_id', '=', warehouse.id),
            ('usage', '=', 'internal'),
        ])

        product_groups = defaultdict(lambda: {'occupied': 0, 'total': 0, 'locations': []})
        company_groups = defaultdict(lambda: {'occupied': 0, 'total': 0, 'company_id': False})
        total_pallets = rack.total_positions * rack.pallets_per_row
        total_occupied = 0

        for loc in locations:
            total_qty = sum(loc.quant_ids.mapped('quantity'))
            occupied = total_qty > 0
            product_name = False
            company_id = False
            if occupied and loc.quant_ids:
                quant = loc.quant_ids[:1]
                product_name = quant.product_id.display_name or 'Sin nombre'
                company_id = quant.product_id.company_id.id or False

            key = product_name or 'Disponible'
            product_groups[key]['total'] += 1
            if occupied:
                product_groups[key]['occupied'] += 1
                total_occupied += 1
            product_groups[key]['locations'].append({
                'id': loc.id,
                'name': loc.name,
                'occupied': occupied,
                'product': product_name,
            })

            company_key = company_id or 0
            company_groups[company_key]['total'] += 1
            if occupied:
                company_groups[company_key]['occupied'] += 1
            company_groups[company_key]['company_id'] = company_id

        groups = []
        for name, data in sorted(product_groups.items(), key=lambda x: -x[1]['occupied']):
            groups.append({
                'name': name,
                'occupied': data['occupied'],
                'total': data['total'],
                'percentage': round((data['occupied'] / data['total'] * 100) if data['total'] else 0, 1),
            })

        company_groups_list = []
        for cid, data in sorted(company_groups.items(), key=lambda x: -x[1]['occupied']):
            company_groups_list.append({
                'company_id': data['company_id'] or False,
                'occupied': data['occupied'],
                'total': data['total'],
                'percentage': round((data['occupied'] / data['total'] * 100) if data['total'] else 0, 1),
            })

        return {
            'total': total_pallets,
            'occupied': total_occupied,
            'free': total_pallets - total_occupied,
            'percentage': round((total_occupied / total_pallets * 100) if total_pallets else 0, 1),
            'groups': groups,
            'companyGroups': company_groups_list,
        }

    def _compute_occupancy(self, warehouse, racks):
        occupancy = {}
        for rack in racks:
            if rack.rack_type == 'aisle':
                continue

            rack_locations = request.env['stock.location'].search([
                ('complete_name', '=ilike', f'%/{rack.name}/%'),
                ('warehouse_id', '=', warehouse.id),
                ('usage', '=', 'internal'),
            ])

            usable_positions = list(range(1, rack.total_positions + 1))
            rack_occ = {}

            for pos in usable_positions:
                pallets = []
                is_aisle_pos = pos in [int(x.strip()) for x in rack.aisle_positions.split(',') if x.strip()] if rack.aisle_positions else []
                if is_aisle_pos:
                    rack_occ[pos] = {'pallets': [], 'product': None, 'company_id': None, 'isAisle': True}
                    continue

                for sp in range(rack.pallets_per_row):
                    sub_locations = rack_locations.filtered(
                        lambda loc, p=pos, s=sp + 1:
                            (loc.map_position == p if loc.map_position else loc.map_pos_y == p) and
                            (loc.map_slot == str(s) if loc.map_slot else (loc.map_pos_x or 0) == (s - 1))
                    )

                    company_id = False
                    levels_data = {}
                    first_loc = False
                    for level_num in range(1, rack.total_levels + 1):
                        level_locs = sub_locations.filtered(
                            lambda loc, l=level_num:
                                (loc.map_level == str(l) if loc.map_level else loc.map_level == l)
                        )
                        loc = level_locs[:1] if level_locs else request.env['stock.location']
                        total_qty = sum(loc.quant_ids.mapped('quantity')) if loc else 0
                        reserved_qty = sum(loc.quant_ids.mapped('reserved_quantity')) if loc else 0

                        if not first_loc and loc:
                            first_loc = loc

                        loc_company_id = False
                        if total_qty > 0 and loc and loc.quant_ids:
                            loc_company_id = loc.quant_ids[:1].product_id.company_id.id or False
                            if not company_id:
                                company_id = loc_company_id

                        levels_data[level_num] = {
                            'occupied': bool(total_qty > 0),
                            'reserved': bool(reserved_qty >= total_qty > 0),
                            'product': loc.quant_ids[:1].product_id.display_name if total_qty > 0 and loc and loc.quant_ids else False,
                            'qty': total_qty,
                            'company_id': loc_company_id,
                        }

                    pallet_occupied = any(ld['occupied'] for ld in levels_data.values())
                    first_quant = first_loc and first_loc.quant_ids[:1] if first_loc else None
                    pallets.append({
                        'free': not pallet_occupied,
                        'product': next((ld['product'] for ld in levels_data.values() if ld['product']), None),
                        'levels': levels_data,
                        'locId': first_loc.id if first_loc else None,
                        'tooltipData': {
                            'id': first_loc.id if first_loc else None,
                            'name': rack.name.replace('RACK ', '') + '-' + str(pos).zfill(2) + '-N' + str(level_num) + '-P' + str(sp + 1) if first_loc else '',
                            'product': next((ld['product'] for ld in levels_data.values() if ld['product']), None),
                            'lot': first_quant.lot_id.name if first_quant and first_quant.lot_id else None,
                            'qty': total_qty if first_loc else 0,
                            'uom': first_quant.product_uom_id.display_name if first_quant else None,
                        } if first_loc else None,
                    })

                rack_occ[pos] = {
                    'pallets': pallets,
                    'product': next((p['product'] for p in pallets if p['product']), None),
                    'company_id': company_id,
                }

            occupancy[rack.name] = rack_occ

        return occupancy

    def _compute_stats(self, racks, occupancy):
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

    @http.route('/warehouse_map/save_company_colors', type='jsonrpc', auth='user')
    def save_company_colors(self, colors):
        for color_data in colors:
            company = request.env['res.company'].browse(color_data['id'])
            if company.exists():
                company.write({'map_color': color_data['color']})
        return {'success': True}
