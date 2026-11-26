import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { Badge, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select } from '../../components/ui';

interface Row {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  details: unknown;
  ip: string | null;
  createdAt: string;
  user: { id: number; name: string; username: string } | null;
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState<number | ''>('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const a = useDebounced(action);
  const users = useQuery({ queryKey: ['users', '', ''], queryFn: () => api.get<{ id: number; name: string }[]>('/admin/users') });
  const q = useQuery({
    queryKey: ['audit', page, userId, a, from, to],
    queryFn: () => api.get<{ total: number; rows: Row[] }>(`/audit${qs({ page, pageSize: 50, userId, action: a, from, to })}`),
  });
  return (
    <div>
      <PageHeader eyebrow="Administración" title="Bitácora de acciones" subtitle="Registro de inicios de sesión, cambios de configuración, precios, pagos y movimientos de caja." />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="min-w-[200px]">
          <span className="label">Usuario</span>
          <Select value={userId} onChange={(e) => (setPage(1), setUserId(e.target.value ? Number(e.target.value) : ''))}>
            <option value="">Todos</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="min-w-[200px] flex-1">
          <span className="label">Acción</span>
          <Input value={action} onChange={(e) => (setPage(1), setAction(e.target.value))} placeholder="Ej. PAYMENT, CASH, PRODUCT..." />
        </label>
        <label>
          <span className="label">Desde</span>
          <Input type="date" value={from} onChange={(e) => (setPage(1), setFrom(e.target.value))} />
        </label>
        <label>
          <span className="label">Hasta</span>
          <Input type="date" value={to} onChange={(e) => (setPage(1), setTo(e.target.value))} />
        </label>
      </Card>
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.rows.length ? (
          <EmptyState icon={<BookOpen className="h-7 w-7" />} title="Sin registros" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Usuario</th>
                    <th>Acción</th>
                    <th>Entidad</th>
                    <th>Detalle</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-ink-500">{dateTime(r.createdAt)}</td>
                      <td className="font-semibold">{r.user?.name ?? '—'}</td>
                      <td>
                        <Badge className={r.action.includes('FAILED') ? 'bg-rose-50 text-rose-700 ring-rose-200' : undefined}>{r.action}</Badge>
                      </td>
                      <td className="text-ink-500">
                        {r.entity}
                        {r.entityId ? ` #${r.entityId}` : ''}
                      </td>
                      <td className="max-w-md truncate font-mono text-[11px] text-ink-500" title={r.details ? JSON.stringify(r.details) : ''}>
                        {r.details ? JSON.stringify(r.details) : '—'}
                      </td>
                      <td className="text-xs text-ink-400">{r.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={50} total={q.data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
