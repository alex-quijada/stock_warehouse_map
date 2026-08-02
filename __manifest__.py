{
    'name': 'Mapa Virtual del Almacén',
    'version': '3.0.1',
    'category': 'Warehouse',
    'summary': 'Mapa interactivo 2D del almacén: racks, pasillos y ocupación en tiempo real',
    'description': """
Mapa Virtual del Almacén Principal - Margarita 
========================

Mapa interactivo 2D del almacén construido con **OWL** (Odoo Web Library).

Características principales
---------------------------
* **Vista de mapa en tiempo real**: representa racks (RACK A–I), pasillos
  (PASILLO 1–5) y el PASILLO 6 como grilla interactiva.
* **Ocupación por nivel**: cada celda muestra hasta 6 pallets (P) x 6 niveles
  (N), coloreados según estado: verde = disponible, rojo = ocupado,
  naranja = reservado.
* **Tooltips interactivos**: al hacer clic en una celda se abre un panel
  flotante arrastrable con productos, cantidades, lote y empresa que ocupa.
* **Edición manual**: agregar/quitar pallets y niveles, mover contenido
  entre ubicaciones (drag & drop) y guardar la ocupación manual.
* **Filtro por empresa**: cada empresa se colorea con su color configurado.
* **Múltiples almacenes**: desplegable para alternar entre almacenes.
* **Exportación a Excel**: genera un reporte .xlsx del mapa con colores.
* **Importación desde Excel**: asistente para cargar ubicaciones
  (rack, posición, nivel, puesto) desde un archivo .xlsx.

Dependencias
------------
* ``stock``
* ``web``

Acceso
------
El menú *Configuración → Mapa Virtual* del módulo de Inventario abre el
mapa. También incluye *Importar ubicaciones* para cargar la grilla desde
Excel. Requiere grupo *stock.group_stock_manager*.
""",
    'author': 'BrandIA Alexandra del Valle Quijada',
    'website': 'https://www.grupoleiros.com',
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
    'images': [
        'static/description/icon.png',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
