import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Search, UserPlus, Users as UsersIcon, UserX } from 'lucide-react';
import { api, errorMessage, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Toggle, useConfirm } from '../../components/ui';

interface UserRow {
  id: number;
  name: string;
  username: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  role: { id: number; code: string; name: string };
}
export interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  userCount: number;
  permissions: string[];
  forbidden: string[];
}

const ROLE_COLOR: Record<string, string> = {
  ADMIN: 'bg-ink-900 text-white ring-ink-900',
  WAITER: 'bg-brand-50 text-brand-700 ring-brand-200',
  KITCHEN: 'bg-amber-50 text-amber-800 ring-amber-200',
  BAR: 'bg-sky-50 text-sky-700 ring-sky-200',
  CASHIER: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};

export default function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [roleId, setRoleId] = useState<number | ''>('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const s = useDebounced(search);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/admin/roles') });
  const q = useQuery({ queryKey: ['users', s, roleId], queryFn: () => api.get<UserRow[]>(`/admin/users${qs({ search: s, roleId })}`) });
  const deactivate = useMutation({
    mutationFn: (id: number) => api.del(`/admin/users/${id}`),
    onSuccess: () => (toast.success('Usuario desactivado'), qc.invalidateQueries({ queryKey: ['users'] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader eyebrow="Administración" title="Usuarios" subtitle="Los usuarios nunca se eliminan: se desactivan para conservar el historial." actions={<Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>Nuevo usuario</Button>} />
      <Card className="mb-4 flex flex-wrap gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input className="pl-10" placeholder="Buscar por nombre o usuario..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="w-auto min-w-[180px]" value={roleId} onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Todos los roles</option>
          {roles.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Card>
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.length ? (
          <EmptyState icon={<UsersIcon className="h-7 w-7" />} title="Sin usuarios" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Último acceso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.map((u) => (
                  <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
                    <td className="font-semibold">{u.name}</td>
                    <td className="font-mono text-xs">{u.username}</td>
                    <td>
                      <Badge className={ROLE_COLOR[u.role.code]}>{u.role.name}</Badge>
                    </td>
                    <td>{u.active ? <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200" dot="bg-emerald-500">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
                    <td className="text-ink-500">{dateTime(u.lastLoginAt)}</td>
                    <td className="text-right">
                      <IconButton onClick={() => setEditing(u)} title="Editar">
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      {u.active && u.id !== me?.id && (
                        <IconButton
                          title="Desactivar"
                          className="hover:text-rose-600"
                          onClick={async () => {
                            if (await confirm({ title: `Desactivar a ${u.name}`, message: 'El usuario no podrá iniciar sesión y se cerrarán sus sesiones activas.', danger: true, confirmText: 'Desactivar' })) deactivate.mutate(u.id);
                          }}
                        >
                          <UserX className="h-4 w-4" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <UserForm user={editing === 'new' ? null : editing} roles={roles.data ?? []} isSelf={editing !== 'new' && editing.id === me?.id} onClose={() => setEditing(null)} onSaved={() => (qc.invalidateQueries({ queryKey: ['users'] }), setEditing(null))} />}
    </div>
  );
}

function UserForm({ user, roles, isSelf, onClose, onSaved }: { user: UserRow | null; roles: RoleRow[]; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: user?.name ?? '', username: user?.username ?? '', password: '', roleId: user?.role.id ?? roles.find((r) => r.code === 'WAITER')?.id ?? 0, active: user?.active ?? true });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: f.name, username: f.username, roleId: f.roleId, active: f.active };
      if (f.password) body.password = f.password;
      return user ? api.put(`/admin/users/${user.id}`, body) : api.post('/admin/users', body);
    },
    onSuccess: () => (toast.success(user ? 'Usuario actualizado' : 'Usuario creado'), onSaved()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const userErr = f.username && !/^[a-z0-9._-]{3,}$/.test(f.username) ? 'Mín. 3 caracteres: minúsculas, números, . _ -' : null;
  const pwErr = (!user && f.password.length < 8) || (f.password && f.password.length < 8) ? 'Mínimo 8 caracteres' : null;
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? 'Editar usuario' : 'Nuevo usuario'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={f.name.trim().length < 2 || !f.username || !!userErr || !!pwErr || !f.roleId} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre completo" className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} autoFocus />
        </Field>
        <Field label="Usuario" error={userErr}>
          <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={60} />
        </Field>
        <Field label={user ? 'Nueva contraseña' : 'Contraseña'} error={f.password || !user ? pwErr : null} hint={user ? 'Déjela en blanco para no cambiarla' : undefined}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Rol" className="sm:col-span-2" hint={isSelf ? 'No puede cambiar su propio rol' : undefined}>
          <Select value={f.roleId} disabled={isSelf} onChange={(e) => setF({ ...f, roleId: Number(e.target.value) })}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {!isSelf && <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label={f.active ? 'Activo' : 'Inactivo'} />}
      </div>
    </Modal>
  );
}
