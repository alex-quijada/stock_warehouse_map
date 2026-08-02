# Arquitectura del Mapa Virtual del Almacén

Documentación técnica del módulo **stock_warehouse_map** (Odoo 19, frontend OWL).

Índice
- [1. Visión general](#1-visión-general)
- [2. Estructura del módulo](#2-estructura-del-módulo)
- [3. Modelos de datos](#3-modelos-de-datos)
- [4. Flujo de datos (backend → frontend)](#4-flujo-de-datos-backend--frontend)
- [5. Endpoints HTTP](#5-endpoints-http)
- [6. Lógica del backend (controllers)](#6-lógica-del-backend-controllers)
- [7. Lógica del frontend (OWL)](#7-lógica-del-frontend-owl)
- [8. Grilla: mapeo posición → ubicación real](#8-grilla-mapeo-posición--ubicación-real)
- [9. PASILLO 6 (tipo special)](#9-pasillo-6-tipo-special)
- [10. Edición manual y guardado](#10-edición-manual-y-guardado)
- [11. Exportación / importación Excel](#11-exportación--importación-excel)
- [12. Seguridad y permisos](#12-seguridad-y-permisos)
- [13. Condicionales clave (resumen)](#13-condicionales-clave-resumen)
- [14. Tareas pendientes conocidas](#14-tareas-pendientes-conocidas)

---

## 1. Visión general

El módulo dibuja un **mapa 2D del almacén PR01 (Margarita)** en el navegador:

- Columnas: **RACK A–I**, **PASILLO 1–5** y **PASILLO 6**.
- Filas: posiciones **1..N** (43 para la mayoría de racks, 41 para G/H/I).
- Cada celda de un rack muestra **pallets (P) × niveles (N)** con colores:
  - Verde `#22c55e` → disponible
  - Rojo `#ef4444` → ocupado
  - Naranja `#f97316` → reservado
- Al hacer clic en una celda se abre un **tooltip flotante** con el detalle
  (productos, cantidades, lote, empresa).
- El estado se calcula en **tiempo real** desde los `stock.quant` de las
  ubicaciones reales (cada vez que se abre el mapa).

El backend (Python) calcula la ocupación leyendo `stock.location` +
`stock.quant`; el frontend (OWL/JS) solo dibuja y permite editar.

---

## 2. Estructura del módulo

```
stock_warehouse_map/
├── __init__.py                  # importa models, controllers, wizards
├── __manifest__.py              # metadatos del módulo
├── controllers/
│   └── warehouse_map_controller.py   # rutas HTTP/JSON-RPC
├── data/
│   └── warehouse_map_data.xml   # configuración inicial de racks/pasillos
├── models/
│   ├── warehouse_map.py         # warehouse.map y warehouse.map.rack
│   └── stock_location.py        # extensión de stock.location (campos de mapa)
├── security/
│   └── ir.model.access.csv      # ACLs
├── static/
│   ├── description/icon.png     # icono del módulo (App Store)
│   ├── dist/warehouse-map.css   # estilos del mapa (light/dark)
│   └── src/warehouse_map/
│       ├── warehouse_map.js     # componente OWL (toda la lógica visual)
│       └── warehouse_map.xml    # template raíz del componente
├── views/
│   ├── menu.xml                 # menús y acciones
│   ├── warehouse_map_views.xml  # vistas form/list del modelo warehouse.map
│   └── import_wizard_views.xml  # vista del asistente de importación
└── wizards/
    └── warehouse_map_import_wizard.py  # importación de ubicaciones desde Excel
```

---

## 3. Modelos de datos

### `warehouse.map` (configuración del mapa)

| Campo          | Tipo          | Descripción                                  |
| -------------- | ------------- | -------------------------------------------- |
| `warehouse_id` | Many2one `stock.warehouse` | Almacén al que pertenece el mapa. Vacío = mapa global (fallback para PR01). |
| `rack_ids`     | One2many `warehouse.map.rack` | Racks y pasillos que componen el mapa. |
| `company_id`   | Many2one `res.company` (related, store) | Empresa del almacén. |

Método `action_open_map()`: devuelve la acción que abre el formulario del mapa.

### `warehouse.map.rack` (definición de un rack o pasillo)

| Campo              | Tipo       | Descripción                                                    |
| ------------------ | ---------- | -------------------------------------------------------------- |
| `name`             | Char       | Nombre: `RACK A`…`RACK I`, `PASILLO 1`…`PASILLO 5`, `PASILLO 6`. |
| `sequence`         | Integer    | Orden en el mapa (RACK A=10, PASILLO 1=20, … PASILLO 6=150).   |
| `map_id`           | Many2one `warehouse.map` | Mapa al que pertenece.                            |
| `rack_type`        | Selection  | `rack` (estantería), `aisle` (pasillo), `special` (PASILLO 6). |
| `total_positions`  | Integer    | Nº de posiciones de la grilla (default 43).                    |
| `total_levels`     | Integer    | Nº de niveles por pallet (default 3, PASILLO 6 = 1).           |
| `aisle_positions`  | Char       | Posiciones que son cruce de pasillo, p.ej. `"15,37"`.          |
| `pallets_per_row`  | Integer    | Pallets por celda. **En la práctica el backend fija 2** para racks. |
| `has_front_back`   | Boolean    | Indica filas frontal/trasera (duplica capacidad).              |
| `pos_x`, `pos_y`   | Integer    | Posición visual (legacy).                                      |
| `width`, `height`  | Integer    | Tamaño visual (legacy).                                        |
| `capacity`         | Integer (compute, store) | Capacidad = posiciones_útiles × niveles × pallets × lados. |
| `capacity_note`    | Char       | Nota (se muestra en la fila de capacidad, p.ej. empresa del pasillo). |
| `company_ids`      | Many2many `res.company` | Empresas asignadas al rack. Vacío = compartido. |

### `stock.location` (extensión)

Campos del mapa virtual por ubicación real:

| Campo            | Tipo       | Descripción                                              |
| ---------------- | ---------- | -------------------------------------------------------- |
| `map_pos_x`, `map_pos_y`, `map_level_old`, `map_row`, `map_rack_id` | (legacy) | Campos antiguos, mantenidos por compatibilidad. |
| `is_map_location`| Boolean    | ¿Es parte del mapa virtual?                              |
| `map_rack`       | Char       | Letra del rack (A–I / P6).                               |
| `map_position`   | Integer    | Nº de espacio/fila (1-43 / 1-90).                        |
| `map_level`      | Selection (1/2/3) | Nivel.                                          |
| `map_slot`       | Selection (1/2)   | Puesto del nivel.                                |
| `map_color`      | Char (compute) | `#9E9E9E` vacío, `#4CAF50` con stock.              |
| `map_company_id` | Many2one (compute) | Empresa del producto que ocupa.              |

---

## 4. Flujo de datos (backend → frontend)

```
 Navegador (OWL)                         Servidor Odoo
┌───────────────────────┐              ┌──────────────────────────────┐
│ WarehouseMap.start()  │──rpc──────▶  │ /warehouse_map/get_warehouses│
│                       │◀──────────── │  lista de almacenes + main   │
│ WarehouseMap.load(id) │──rpc──────▶  │ /warehouse_map/get_map_data  │
│                       │              │  {racks, occupancy, stats,   │
│                       │              │   companyColors}             │
│ draw() → grilla HTML  │              │                              │
│ (interacción usuario) │──rpc──────▶  │ /warehouse_map/save_occupancy│
│                       │              │ /warehouse_map/save_company_ │
│                       │              │     colors                   │
│ exportar Excel        │──http GET──▶ │ /warehouse_map/export_excel  │
└───────────────────────┘              └──────────────────────────────┘
```

1. **`start()`** pide la lista de almacenes (`get_warehouses`). Si el RPC
   falla, cae a `orm.searchRead("stock.warehouse", …)`.
2. Selecciona como principal el almacén con código **PR01** (`_isMargarita`).
3. **`load(id)`** pide los datos del mapa (`get_map_data`).
4. **`draw()`** construye la grilla completa como HTML (tabla) e inyecta en
   el DOM, guardando scroll anterior y restaurándolo.
5. Las interacciones (clic, drag&drop, edición) mutan `this.data.occupancy`
   y vuelven a llamar `draw()`.

---

## 5. Endpoints HTTP

| Ruta                                | Tipo      | Auth | Descripción                                        |
| ----------------------------------- | --------- | ---- | -------------------------------------------------- |
| `/warehouse_map/get_map_data`       | jsonrpc   | user | Devuelve racks, ocupación, stats y colores.        |
| `/warehouse_map/get_warehouses`     | jsonrpc   | user | Almacenes del usuario + `main_warehouse_id`.       |
| `/warehouse_map/save_occupancy`     | jsonrpc   | user | Guarda la ocupación manual en `ir.config_parameter`.|
| `/warehouse_map/save_company_colors`| jsonrpc   | user | Persiste `map_color` por empresa.                  |
| `/warehouse_map/export_excel`       | http      | user | Descarga `mapa_{code}.xlsx`.                       |

Todas usan `auth='user'` (requieren sesión iniciada).

---

## 6. Lógica del backend (controllers)

### 6.1 `get_map_data(warehouse_id)`

1. Busca el almacén; si no existe → `{'error': 'Almacén no encontrado'}`.
2. Busca una ubicación interna (`usage='internal'`); si no hay →
   `{'error': 'Este es un almacén no físico, no puede haber mapa 2D'}`.
3. Busca el `warehouse.map` del almacén. Si no hay y el almacén se llama
   *principal* → usa el mapa global (`warehouse_id = False`).
4. Construye `rack_data`: lista de metadatos por rack (id, name, type,
   totalPositions, totalLevels, aislePositions, palletsPerRow, hasFrontBack,
   capacity, capacityNote, companyIds).
5. Calcula `occupancy` con `_compute_occupancy()`.
6. Calcula `stats` con `_compute_stats()`.
7. Construye `companyColors` con `_get_company_colors()` (usa
   `res.company.map_color`, default `#2196F3`).
8. **Overrides manuales**: si `ir.config_parameter` contiene la clave
   `warehouse_map.occupancy.{warehouse_id}`, los datos guardados
   manualmente sobreescriben la ocupación calculada (por rack/posición).

### 6.2 `_compute_occupancy(warehouse, racks)` — el corazón

Para cada rack (salta los de tipo `aisle`):

1. **Árbol de ubicaciones**: busca la ubicación raíz `Stock` del almacén
   (`warehouse_id` + nombre `Stock`) y construye el prefijo
   `prefix = stock_root.complete_name`. **No filtra por empresa**: el
   prefijo ancla al `Stock` del almacén para no traer árboles de otros
   almacenes (PR02, PR03, TCGM…) que comparten nombres de rack.
2. **Tipo `special` (PASILLO 6)**: genera una grilla decorativa. Para cada
   posición 1..`total_positions` (90) crea `pallets_per_row` (21) pallets
   vacíos:
   ```python
   {'free': True, 'product': None, 'levels': {},
    'locId': None, 'company_id': False}
   ```
   No consulta `stock.location` ni `stock.quant`. El frontend dibuja solo
   las celdas que usa el esquema decorativo.
3. **Tipo `rack`**:
   a. Busca las ubicaciones internas cuyo `complete_name` empieza por
      `{prefix}/{rack.name}/` (`RACK A/…`).
   b. Busca los `stock.quant` con `quantity > 0` de esas ubicaciones y
      agrega por ubicación: `qty_by_loc`, `reserved_by_loc`,
      `quants_by_loc`.
   c. **Agrupación**: parsea cada nombre de ubicación con
      `RACK_NAME_RE = ^RACK ([A-I])(\d+)-(\d+)$` → `(letra, posicion, nivel)`.
      Deduplica claves idénticas `(letra, pos, nivel)` por empresa
      (varias empresas crean ubicaciones con el mismo nombre; se guarda una
      por empresa y luego se agrega el stock de todas).
   d. **Por celda de grilla**:
      - Si `grid_pos` está en `aisle_positions` (15 ó 37) → celda pasillo
        (`{'isAisle': True}`).
      - Calcula `pair_index` saltando las posiciones de pasillo
        (`pair_index = pos - (1 si pos>15) - (1 si pos>37)`).
      - Los pallets de la celda corresponden a las ubicaciones
        `(2N-1)` y `(2N)` (dos posiciones consecutivas por celda).
      - Para cada pallet y cada nivel 1..`total_levels`, junta las
        ubicaciones reales de todas las empresas:
        `total_qty`, `reserved_qty`, productos (`display_name`, qty, uom,
        lot) y `company_id` de la ubicación ocupada.
      - `pallet['free'] = not any level occupied`.
      - `pallet['tooltipData']` con `{id, name: A{pos:02d}-{nivel},
        product, qty}`.
      - `company_id` de la celda = primera empresa con stock.

### 6.3 `_compute_stats(racks, occupancy)`

Recorre solo racks de tipo `rack`; por cada pallet de cada posición no-pasillo
cuenta `total` y `occupied` (pallet no libre). Devuelve
`{total, free, occupied, percentage}`.

### 6.4 `get_warehouses()`

Lee la cookie `cids` (empresas activas del usuario), filtra almacenes por la
primera empresa y marca como `main_warehouse_id` el de código `PR01` (o cuyo
nombre contenga *principal*).

### 6.5 `save_occupancy(warehouse_id, occupancy)`

Guarda `occupancy` como JSON en `ir.config_parameter` bajo la clave
`warehouse_map.occupancy.{warehouse_id}` (sin tipo de dato ni validación).

### 6.6 `save_company_colors(colors)`

Escribe `res.company.map_color` para cada `{id, color}` recibido.

---

## 7. Lógica del frontend (OWL)

Componente `WarehouseMap` (`static/src/warehouse_map/warehouse_map.js`),
registrado como acción client `warehouse_map`.

### 7.1 Colores y utilidades

- `C` = paleta (disponible, ocupado, reservado, pasillo, cruce, cabeceras).
- `z(n)` = rellena con 2 dígitos (`3` → `"03"`).
- `esc(s)` = escapa HTML.

### 7.2 `draw()`

Construye y monta, en orden:

1. **Top bar**: selector de almacén, barra de progreso de ocupación
   (`percentage`, color rojo >80%, ámbar >50%, verde), badges de libres y
   ocupadas, botón **Guardar** si hay cambios pendientes (`_dirty`).
2. **Leyenda**: Disponible / Ocupado / Reservado / Pasillo.
3. **Grilla (tabla)**:
   - Cabecera: nombre de cada rack (`rackTitle`).
   - Por fila `p = 1..maxPos` y por rack:
     - `aisle` → celda gris con `⇄` en cruces (15/37) y `│` en el resto.
     - `special` → una sola celda `rowspan` con el esquema PASILLO 6.
     - `p > totalPositions` → botón `+` para extender el rack
       (`extendRack`).
     - resto → celdas `wh-cell` con los puntos de color por pallet/nivel.
4. **Sidebar** (`_buildSidebar`): detalle de la posición seleccionada.

Al final: asigna `window._owh = this` (los `onclick` inline lo usan),
conecta el `onchange` del selector y renderiza el tooltip.

### 7.3 Colores de celda

`dotColor(rack, pos, palIdx, level)`:
- pallet libre → verde
- nivel reservado → naranja
- nivel ocupado → rojo
- si no hay dato → verde (por defecto)

`posStatus(rack, pos)` devuelve `"free" | "reserved" | "occupied"`.

### 7.4 Cálculo de niveles visibles

- `palN` = nº de pallets de la celda (mín. 2, máx. 6).
- `maxLv` = mayor nivel presente.
- `lvN` = máx. entre `totalLevels` del rack y `maxLv` (máx. 6).

### 7.5 Sidebar (`_buildSidebar`)

- Sin selección → mensaje "Haz clic en una posición…".
- **PASILLO 6** → `PASILLO 6 · NN` + "Este pasillo no está mapeado."
- Pasillo / sin datos → "Sin información para esta posición."
- Rack → título `RACK X · NN`, y por pallet/nivel: nombre corto
  (`A03-1`), nombre completo (`complete_name`), empresa (con su color) y
  lista de productos con cantidades/lote. Si está vacío → "Disponible".

### 7.6 PASILLO 6 (`_buildPasillo6`)

Esquema **decorativo** (aún sin mapeo real a ubicaciones):

- `cell(pos, palletIdx)`: dibuja una celdita 12×12. Devuelve `''` para las
  posiciones de pasillo (15 y 37). El color del nivel usa
  reservado→naranja, ocupado→rojo, libre→verde; sin niveles → verde.
- `row2(arr, n, sp, startPallet, stride, posOffset)`: dibuja 2 filas por
  cada posición de la lista (pallets `start..start+n-1` y
  `start+stride..start+stride+n-1`).
- `blk(larr, rarr, sp, rOff)`: bloque de 3 secciones — columna izquierda
  (6 celdas), franja gris central de 36px (el pasillo), columna derecha
  (11 celdas).
- `crossBar()`: barra de cruce (las filas 15 y 37) con `⇄`.
- `range(from, to)`: lista de enteros.

Layout final (columna izquierda `lc=6`, derecha `rc=11`):

```
blk(1-14,1-14, sp=1, rOff=43)      → filas 1..14 (derecha filas 44..57)
crossBar()                          → fila 15
blk(16-18,16-18, sp=16, rOff=43)    → filas 16..18
gap (aisle)                         → fila 19
blk(20-22,20-22, sp=20, rOff=43)    → filas 20..22
gap                                 → fila 23 (ocupada por blk? ver layout)
blk(23-36,23-36, sp=23, rOff=43)    → filas 23..36
crossBar()                          → fila 37
blk(38-43,38-43, sp=38, rOff=43)    → filas 38..43
```

El offset `43` en la columna derecha hace que las celdas derechas apunten a
las posiciones 44..57, 59..61, 63..65, 66..79, 81..86 (con los huecos de
cruce 58/62/80). `toggleTip` rellena cada pallet hasta 34 celdas al hacer
clic, para que el tooltip tenga datos consistentes.

### 7.7 Tooltip flotante

- `toggleTip(rack, pos, ev, cellIdx)`:
  - Rechaza si no hay pallets.
  - Fija `this.selected`.
  - Para PASILLO 6 rellena pallets hasta `targetCount=34` con
    `levels` de 1 nivel; para racks hasta `palletsPerRow` (mín. 2).
  - Si es el mismo tooltip → lo cierra; si no, lo abre.
- `_tipHtml()`: tarjeta con cabecera arrastrable (`data-wh-drag`).
  - PASILLO 6 → tabla con 1 puesto (P1) y sus niveles (N1..N3), celdas
    clicables para alternar ocupado, botones `+`/`✕` para niveles.
  - Rack → tabla con pallets (P1..Pn) y niveles (N1..N6), productos,
    botones para añadir/eliminar pallets y niveles.
- `toggleLevel(palIdx, level)`: alterna `occupied` y recalcula `free`.
- `addPallet/removePallet/addLevel/removeLevel`: edición de la grilla.
  - PASILLO 6 solo permite 1 pallet fijo y máx. 3 niveles.
  - Racks máx. 6 pallets y 6 niveles.
- `_tipWarn(msg)`: muestra un aviso temporal en el tooltip.

### 7.8 Drag & drop

- `dragStart/dragOver/drop`: mueve la ocupación entre celdas de racks
  (no permite mover a/hacia PASILLO 6 ni a celdas pasillo). Marca
  `_dirty` y redibuja.

### 7.9 Guardado

`saveChanges()` → RPC `save_occupancy` con `this.data.occupancy` completo.
Al éxito, limpia `_dirty` y redibuja.

---

## 8. Grilla: mapeo posición → ubicación real

Convención de nombres de ubicación (ejemplo real):

```
PR01/Stock/RACK A/RACK A01-1
PR01/Stock/RACK A/RACK A01-2     ← posición 01, nivel 2
PR01/Stock/RACK A/RACK A01-3     ← posición 01, nivel 3
```

- `RACK_NAME_RE = ^RACK ([A-I])(\d+)-(\d+)$` captura
  `letra=A`, `posicion=01`, `nivel=1`.
- La **celda `N` de la grilla** corresponde a las posiciones reales
  `2N-1` y `2N` (dos pallets por celda).
- Las **posiciones 15 y 37** son cruces de pasillo y no tienen pallets.
- Como `pair_index` salta las filas de pasillo, la fila real `16`
  corresponde a `pair_index=15` → posiciones reales `29-30`, etc.

### Cálculo de la fila real de una posición

```python
pair_index = grid_pos - (1 if grid_pos > 15 else 0) - (1 if grid_pos > 37 else 0)
pallet_positions = (2 * pair_index - 1, 2 * pair_index)
```

En el frontend el mismo cálculo se repite con:
```js
const lp = p - (p>15?1:0) - (p>37?1:0);
const fp = 2*lp - 1;   // primera posición real del par
```

---

## 9. PASILLO 6 (tipo special)

- Es **almacenamiento en piso** (no estantería): `rack_type='special'`,
  `total_positions=90`, `total_levels=1`, `pallets_per_row=21`.
- El **backend** devuelve una grilla vacía decorativa (21 pallets libres
  por posición, sin niveles, sin consultar ubicaciones).
- El **frontend** dibuja el esquema decorativo (bloques izquierda/derecha
  con separación central, cruces en 15/37) y muestra en el sidebar
  **"Este pasillo no está mapeado."**
- Los tooltips de PASILLO 6 permiten **editar manualmente** (marcar niveles
  ocupados) y guardar con `save_occupancy`.

> **Estado actual**: PASILLO 6 no está conectado a ubicaciones reales
> (`PILAR B…`). La regex `PASILLO6_NAME_RE` existe en el controller pero ya
> no se usa. Mapearlo correctamente es una tarea pendiente (ver §14).

---

## 10. Edición manual y guardado

1. El usuario hace clic en una celda → tooltip.
2. Alterna niveles (`toggleLevel`), añade/elimina pallets o niveles
   (`addPallet/removePallet/addLevel/removeLevel`) o mueve con drag&drop.
3. Cada cambio marca `this._dirty = true` y muestra el botón **Guardar**.
4. **Guardar** → `saveChanges()` → `POST /warehouse_map/save_occupancy`
   con la ocupación completa.
5. El backend la guarda en `ir.config_parameter`. Al volver a cargar el
   mapa, `get_map_data` la reaplica como *override* sobre la ocupación
   calculada (ver §6.1 punto 8).

> **Importante**: el guardado manual sobreescribe la ocupación calculada
> de los quants mientras exista el override. Borra la clave
> `warehouse_map.occupancy.{warehouse_id}` para volver al cálculo real.

---

## 11. Exportación / importación Excel

### 11.1 Exportación (`export_excel`)

- Genera un `.xlsx` con `xlsxwriter`:
  - Fila 0: cabecera con `POS` y el nombre de cada rack (merge por
    `pallets_per_row`).
  - Filas 1..43: nº de fila (salvo cruces 15/37) y por rack una celda por
    pallet coloreada: verde=libre, rojo=ocupado, gris=pasillo,
    naranja=cruce.
  - Busca ocupación real por `map_position`/`map_pos_y` de las
    `stock.location`.
- No incluye PASILLO 6 (filtra `rack_type != 'special'`).

### 11.2 Importación (`warehouse.map.import.wizard`)

- Formulario: seleccionar almacén + archivo Excel.
- Lee columnas por nombre (rack / posicion / nivel / puesto).
- Construye `complete_name` como `{rack}-{pos:02d}-N{nivel}-P{puesto}`.
- Si la ubicación ya existe → actualiza `is_map_location`, `map_rack`,
  `map_position`, `map_level`, `map_slot`; si no → crea la ubicación
  interna bajo `warehouse.view_location_id`.
- Muestra un log con nº de exitosas y errores.
- Requiere `openpyxl`.

---

## 12. Seguridad y permisos

`security/ir.model.access.csv`:

| Grupo                | Modelo                    | Leer | Escribir | Crear | Borrar |
| -------------------- | ------------------------- | ---- | -------- | ----- | ------ |
| `stock.group_stock_user`    | `warehouse.map`     | ✓    | ✗        | ✗     | ✗      |
| `stock.group_stock_manager` | `warehouse.map`     | ✓    | ✓        | ✓     | ✓      |
| `stock.group_stock_user`    | `warehouse.map.rack`| ✓    | ✗        | ✗     | ✗      |
| `stock.group_stock_manager` | `warehouse.map.rack`| ✓    | ✓        | ✓     | ✓      |
| `stock.group_stock_manager` | `warehouse.map.import.wizard` | ✓ | ✓ | ✓ | ✓ |

- La **visualización** del mapa está abierta a usuarios de stock (los
  endpoints usan `auth='user'` y consultan con `.sudo()`).
- La **edición** de racks y el asistente de importación requieren
  `stock.group_stock_manager`.
- El menú *Configuración* de Inventario solo es visible para managers.

---

## 13. Condicionales clave (resumen)

| Condición (backend)                                  | Efecto                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `not warehouse.exists()`                             | Error "Almacén no encontrado".                                |
| sin ubicación interna (`usage='internal'`)           | Error "almacén no físico".                                    |
| sin `warehouse.map` y nombre no *principal*          | Error "No hay configuración de mapa".                         |
| `rack.rack_type == 'aisle'`                          | Se salta en `_compute_occupancy`.                             |
| `rack.rack_type == 'special'`                        | Grilla decorativa vacía (PASILLO 6).                          |
| `grid_pos in aisle_positions`                        | Celda pasillo (`isAisle`), sin pallets.                       |
| nombre de ubicación sin match `RACK ([A-I])(\d+)-(\d+)` | Se ignora esa ubicación.                                    |
| `total_qty > 0` en un nivel                          | Nivel ocupado; si además `reserved >= total` → reservado.     |
| any nivel ocupado en el pallet                       | `pallet['free'] = False`.                                     |
| `'principal' in warehouse.name` y sin mapa propio    | Usa el mapa global (`warehouse_id = False`).                  |
| override manual en `ir.config_parameter`            | Sobreescribe la ocupación calculada.                          |

| Condición (frontend)                                 | Efecto                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `rack === 'PASILLO 6'`                               | Tooltip/sidebar especiales, targetCount=34, máx. 3 niveles.   |
| `pos === 15 || pos === 37` (PASILLO 6)               | No dibuja celdas (cruce).                                     |
| `p === 15 || p === 37` (grilla)                      | Fila resaltada `⇄` en pasillos.                               |
| `p > rack.totalPositions`                            | Botón `+` para extender el rack.                              |
| `_isMargarita(wh)` (código PR01)                     | Si es falso → `_notAllowed`, mensaje de solo-PR01.            |
| `pal.free`                                           | Dot verde.                                                    |
| `lv.reserved`                                        | Dot naranja.                                                  |
| `lv.occupied`                                        | Dot rojo.                                                     |
| `_dirty`                                             | Muestra botón Guardar.                                        |
| `srcRack/dstRack === 'PASILLO 6'`                    | Drag&drop bloqueado hacia/desde PASILLO 6.                    |
| rack con `totalLevels` > 6 o pallets > 6             | Se limita a 6 en la UI.                                       |

---

## 14. Tareas pendientes conocidas

- **Mapear PASILLO 6 a ubicaciones reales**: el esquema es decorativo. Las
  ubicaciones reales siguen el patrón `PILAR B(\d+) - [AB](\d+)-(\d+)`
  (`PASILLO6_NAME_RE` ya definida pero sin uso). Falta decidir el esquema de
  mapeo posición/pallet → `PILAR B*` manteniendo el layout decorativo.
- **RACK F/F55-1**: celdas con `quantity = NULL` / `reserved_quantity` 7/12/1
  no se pintan como ocupadas (`total_qty` calculado da 0). Revisar por qué el
  quant no se agrega a `qty_by_loc` (posible ubicación con nombre no parseable
  o fuera del prefijo del rack).
- **Validación de override manual**: `save_occupancy` guarda sin validar
  tipo/estructura; un JSON corrupto rompe `get_map_data`.

---

## Notas de implementación

- El frontend construye **HTML por string concatenado** (no usa la sintaxis
  declarativa de OWL en el template) y llama a `window._owh` desde los
  `onclick` inline. Esto es frágil pero funcional; al refactorizar,
  migrar a eventos OWL.
- `draw()` re-inyecta todo el DOM en cada cambio (pérdida de scroll
  mitigada guardando/restaurando `scrollTop/scrollLeft`).
- Las empresas se colorean en el mapa usando `res.company.map_color`; si no
  tienen color, se usa el azul `#2196F3`.
