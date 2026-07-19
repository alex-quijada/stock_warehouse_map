from odoo import api, fields, models


class ResCompany(models.Model):
    _inherit = 'res.company'

    map_color = fields.Char('Map Color', default='#2196F3',
                             help='Color for this company on the warehouse map')


class WarehouseMap(models.Model):
    _name = 'warehouse.map'
    _description = 'Warehouse Map Configuration'
    _rec_name = 'warehouse_id'

    warehouse_id = fields.Many2one('stock.warehouse', string='Warehouse')
    rack_ids = fields.One2many('warehouse.map.rack', 'map_id', string='Racks')
    company_id = fields.Many2one('res.company', related='warehouse_id.company_id', store=True)

    def action_open_map(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'Mapa - {self.warehouse_id.name}',
            'res_model': 'warehouse.map',
            'res_id': self.id,
            'view_mode': 'form',
            'view_id': self.env.ref('stock_warehouse_map.warehouse_map_form_view').id,
            'target': 'fullscreen',
        }


class WarehouseMapRack(models.Model):
    _name = 'warehouse.map.rack'
    _description = 'Rack Definition'
    _order = 'sequence, id'

    name = fields.Char('Rack Name', required=True)
    sequence = fields.Integer('Sequence', default=10)
    map_id = fields.Many2one('warehouse.map', string='Map', required=True, ondelete='cascade')
    rack_type = fields.Selection([
        ('rack', 'Rack'),
        ('aisle', 'Aisle'),
        ('special', 'Special Aisle'),
    ], string='Type', default='rack', required=True)
    total_positions = fields.Integer('Total Positions', default=43)
    total_levels = fields.Integer('Total Levels', default=3)
    aisle_positions = fields.Char('Aisle Positions', default='15,37',
                                   help='Comma-separated position numbers used as aisles')
    pallets_per_row = fields.Integer('Pallets per Row', default=1,
                                      help='Number of pallet columns per display row')
    has_front_back = fields.Boolean('Front & Back Rows', default=False,
                                     help='Rack has both front and back rows')
    pos_x = fields.Integer('Position X', default=0)
    pos_y = fields.Integer('Position Y', default=0)
    width = fields.Integer('Display Width', default=2)
    height = fields.Integer('Display Height', default=43)
    capacity = fields.Integer('Capacity', compute='_compute_capacity', store=True)
    capacity_note = fields.Char('Capacity Note',
                                 help='Note shown in the capacity row (e.g. company name for aisles)')
    company_ids = fields.Many2many('res.company', string='Assigned Companies',
                                    help='Companies that own this rack. Leave empty for shared racks.')

    @api.depends('total_positions', 'total_levels', 'aisle_positions', 'pallets_per_row', 'has_front_back')
    def _compute_capacity(self):
        for r in self:
            aisles = [int(x.strip()) for x in r.aisle_positions.split(',') if x.strip()] if r.aisle_positions else []
            usable = r.total_positions - len(aisles)
            sides = 2 if r.has_front_back else 1
            r.capacity = usable * r.total_levels * r.pallets_per_row * sides

    def get_usable_positions(self):
        self.ensure_one()
        aisles = [int(x.strip()) for x in self.aisle_positions.split(',') if x.strip()] if self.aisle_positions else []
        return [p for p in range(1, self.total_positions + 1) if p not in aisles]

    def get_location_prefix(self, warehouse):
        return f'{warehouse.view_location_id.complete_name}/{self.name}'
