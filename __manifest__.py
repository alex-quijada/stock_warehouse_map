{
    'name': 'Mapa Virtual del Almacén',
    'version': '3.0',
    'category': 'Warehouse',
    'summary': 'Mapa interactivo 2D del almacén con OWL',
    'description': """
        Módulo que proporciona un mapa interactivo 2D del almacén
        construido con OWL (Odoo Web Library).
        Muestra racks, pasillos y ubicaciones con estado de ocupación
        en tiempo real. Tooltips, filtros por empresa, panel de Pasillo 6.
    """,
    'author': 'BrandIA',
    'depends': ['stock', 'web'],
    'data': [
        'security/ir.model.access.csv',
        'views/menu.xml',
        'views/warehouse_map_views.xml',
        'views/import_wizard_views.xml',
        'data/warehouse_map_data.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'stock_warehouse_map/static/dist/warehouse-map.css',
            'stock_warehouse_map/static/src/**/*.js',
            'stock_warehouse_map/static/src/**/*.xml',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
