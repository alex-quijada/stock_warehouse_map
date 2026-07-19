from odoo import api, fields, models


class StockLocation(models.Model):
    _inherit = 'stock.location'

    # Legacy fields (kept for backward compatibility with existing data)
    map_pos_x = fields.Integer('Map X Position (legacy)')
    map_pos_y = fields.Integer('Map Y Position (legacy)')
    map_level_old = fields.Integer('Map Level (legacy)')
    map_row = fields.Selection([('front', 'Front'), ('back', 'Back')], string='Map Row (legacy)')
    map_rack_id = fields.Many2one('warehouse.map.rack', string='Map Rack (legacy)')

    # New specification fields
    is_map_location = fields.Boolean(string="¿Es parte del mapa virtual?", default=False)
    map_rack = fields.Char(string="Letra del Rack (A-I / P6)")
    map_position = fields.Integer(string="Número de Espacio / Fila (1-43 / 1-90)")
    map_level = fields.Selection([
        ('1', 'Nivel 1'),
        ('2', 'Nivel 2'),
        ('3', 'Nivel 3'),
    ], string="Nivel")
    map_slot = fields.Selection([
        ('1', 'Puesto 1 (Izquierda)'),
        ('2', 'Puesto 2 (Derecha)'),
    ], string="Puesto del Nivel")

    map_color = fields.Char('Map Color', compute='_compute_map_color', store=False)
    map_company_id = fields.Many2one('res.company', string='Map Company',
                                      compute='_compute_map_company', store=False)

    @api.depends('quant_ids.quantity', 'quant_ids.reserved_quantity')
    def _compute_map_color(self):
        for loc in self:
            total_qty = sum(loc.quant_ids.mapped('quantity'))
            if total_qty == 0:
                loc.map_color = '#9E9E9E'
            else:
                loc.map_color = '#4CAF50'

    @api.depends('quant_ids.product_id.company_id')
    def _compute_map_company(self):
        for loc in self:
            company = False
            for quant in loc.quant_ids:
                if quant.product_id.company_id:
                    company = quant.product_id.company_id
                    break
            loc.map_company_id = company
