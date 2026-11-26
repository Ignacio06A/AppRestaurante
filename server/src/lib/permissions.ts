/** Catálogo de permisos del sistema. El administrador puede reasignarlos por rol. */
export const PERMISSIONS = {
  'tables.view': { module: 'Mesas', description: 'Ver el plano de mesas y su estado' },
  'tables.manage': { module: 'Mesas', description: 'Crear, editar y eliminar mesas' },
  'orders.view': { module: 'Pedidos', description: 'Consultar órdenes' },
  'orders.create': { module: 'Pedidos', description: 'Abrir mesas y enviar pedidos' },
  'orders.edit': { module: 'Pedidos', description: 'Modificar pedidos enviados (cantidades, notas, eliminar)' },
  'orders.edit_any': { module: 'Pedidos', description: 'Modificar pedidos de otros meseros' },
  'orders.cancel': { module: 'Pedidos', description: 'Anular órdenes completas' },
  'orders.discount': { module: 'Pedidos', description: 'Aplicar descuentos a una cuenta' },
  'kds.kitchen': { module: 'Cocina', description: 'Acceso a la pantalla de cocina (KDS)' },
  'kds.bar': { module: 'Bar', description: 'Acceso a la pantalla de bar' },
  'payments.view': { module: 'Caja', description: 'Consultar cuentas y pagos' },
  'payments.create': { module: 'Caja', description: 'Registrar pagos' },
  'cash.operate': { module: 'Caja', description: 'Abrir caja y registrar movimientos' },
  'cash.close': { module: 'Caja', description: 'Cerrar caja (arqueo)' },
  'cash.adjust': { module: 'Caja', description: 'Registrar ajustes autorizados de caja' },
  'cash.history': { module: 'Caja', description: 'Consultar historial de aperturas y cierres' },
  'reports.view': { module: 'Reportes', description: 'Ver reportes y estadísticas de ventas' },
  'menu.manage': { module: 'Administración', description: 'Gestionar productos, precios y categorías' },
  'menu.availability': { module: 'Administración', description: 'Marcar productos como agotados/disponibles' },
  'users.manage': { module: 'Administración', description: 'Gestionar usuarios, roles y permisos' },
  'settings.manage': { module: 'Administración', description: 'Configuración general del restaurante' },
  'audit.view': { module: 'Administración', description: 'Consultar bitácora de acciones' },
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

export const ROLE_CODES = ['ADMIN', 'WAITER', 'KITCHEN', 'BAR', 'CASHIER'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleCode, PermissionCode[]> = {
  ADMIN: ALL_PERMISSIONS,
  WAITER: ['tables.view', 'orders.view', 'orders.create', 'orders.edit'],
  KITCHEN: ['kds.kitchen', 'menu.availability'],
  BAR: ['kds.bar', 'menu.availability'],
  CASHIER: ['tables.view', 'orders.view', 'payments.view', 'payments.create', 'cash.operate', 'cash.close', 'cash.history'],
};

/**
 * Regla de negocio 17: cocina y bar NO pueden modificar precios ni registrar pagos,
 * aunque un administrador intente asignarles el permiso.
 */
export const FORBIDDEN_FOR_ROLE: Partial<Record<RoleCode, PermissionCode[]>> = {
  KITCHEN: ['menu.manage', 'payments.create', 'cash.operate', 'cash.close', 'cash.adjust', 'orders.discount'],
  BAR: ['menu.manage', 'payments.create', 'cash.operate', 'cash.close', 'cash.adjust', 'orders.discount'],
};

export const ROLE_LABELS: Record<RoleCode, string> = {
  ADMIN: 'Administrador',
  WAITER: 'Mesero',
  KITCHEN: 'Cocina',
  BAR: 'Bar',
  CASHIER: 'Cajero',
};
