import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { useAuth, homeFor } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Loading, EmptyState } from './components/ui';
import Login from './pages/Login';
import TablesPage from './pages/waiter/Tables';
import OrderScreen from './pages/waiter/OrderScreen';
import KdsPage from './pages/kds/Kds';
import Accounts from './pages/cashier/Accounts';
import Checkout from './pages/cashier/Checkout';
import CashControl from './pages/cashier/CashControl';
import CashHistory from './pages/cashier/CashHistory';
import Dashboard from './pages/admin/Dashboard';
import Reports from './pages/admin/Reports';
import Products from './pages/admin/Products';
import Categories from './pages/admin/Categories';
import TablesAdmin from './pages/admin/TablesAdmin';
import UsersPage from './pages/admin/Users';
import RolesPage from './pages/admin/Roles';
import SettingsPage from './pages/admin/Settings';
import AuditPage from './pages/admin/Audit';
import OrdersPage from './pages/admin/Orders';
import ReceiptPrint from './pages/print/Receipt';
import ClosingPrint from './pages/print/Closing';

function Guard({ perms, children }: { perms?: string[]; children: ReactNode }) {
  const { user, loading, can } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading label="Verificando sesión..." />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (perms && !can(...perms)) {
    return <EmptyState icon={<ShieldX className="h-7 w-7" />} title="Acceso restringido" description="Su rol no tiene permisos para ver este módulo." />;
  }
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return <Navigate to={user ? homeFor(user) : '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Home />} />

      {/* Pantallas KDS a pantalla completa */}
      <Route path="/cocina" element={<Guard perms={['kds.kitchen']}><KdsPage area="KITCHEN" /></Guard>} />
      <Route path="/bar" element={<Guard perms={['kds.bar']}><KdsPage area="BAR" /></Guard>} />

      {/* Vistas de impresión */}
      <Route path="/imprimir/comprobante/:orderId" element={<Guard perms={['payments.view', 'orders.view']}><ReceiptPrint /></Guard>} />
      <Route path="/imprimir/cierre/:sessionId" element={<Guard perms={['cash.history', 'cash.operate']}><ClosingPrint /></Guard>} />

      <Route element={<Guard><AppShell /></Guard>}>
        <Route path="/mesas" element={<Guard perms={['orders.create', 'tables.view']}><TablesPage /></Guard>} />
        <Route path="/mesas/orden/:orderId" element={<Guard perms={['orders.view']}><OrderScreen /></Guard>} />

        <Route path="/caja" element={<Guard perms={['payments.view']}><Accounts /></Guard>} />
        <Route path="/caja/cuenta/:orderId" element={<Guard perms={['payments.view']}><Checkout /></Guard>} />
        <Route path="/caja/control" element={<Guard perms={['cash.operate']}><CashControl /></Guard>} />
        <Route path="/caja/historial" element={<Guard perms={['cash.history']}><CashHistory /></Guard>} />

        <Route path="/admin" element={<Guard perms={['reports.view']}><Dashboard /></Guard>} />
        <Route path="/admin/reportes" element={<Guard perms={['reports.view']}><Reports /></Guard>} />
        <Route path="/admin/ordenes" element={<Guard perms={['reports.view']}><OrdersPage /></Guard>} />
        <Route path="/admin/productos" element={<Guard perms={['menu.manage', 'menu.availability']}><Products /></Guard>} />
        <Route path="/admin/categorias" element={<Guard perms={['menu.manage']}><Categories /></Guard>} />
        <Route path="/admin/mesas" element={<Guard perms={['tables.manage']}><TablesAdmin /></Guard>} />
        <Route path="/admin/usuarios" element={<Guard perms={['users.manage']}><UsersPage /></Guard>} />
        <Route path="/admin/roles" element={<Guard perms={['users.manage']}><RolesPage /></Guard>} />
        <Route path="/admin/configuracion" element={<Guard perms={['settings.manage']}><SettingsPage /></Guard>} />
        <Route path="/admin/bitacora" element={<Guard perms={['audit.view']}><AuditPage /></Guard>} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
