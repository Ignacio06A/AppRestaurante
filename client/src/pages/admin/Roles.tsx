import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { Lock, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Button, Card, CardHeader, Loading, PageHeader } from '../../components/ui';
import type { RoleRow } from './Users';

interface Perm {
  id: number;
  code: string;
  description: string;
  module: string;
}

export default function RolesPage() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/admin/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Perm[]>('/admin/permissions') });
  const [roleId, setRoleId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const role = roles.data?.find((r) => r.id === roleId) ?? roles.data?.[0];

  useEffect(() => {
    if (role) {
      setRoleId(role.id);
      setDraft(new Set(role.permissions));
    }
  }, [role?.id, role?.permissions.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api.put(`/admin/roles/${role!.id}/permissions`, { permissions: [...draft] }),
    onSuccess: () => (toast.success('Permisos actualizados'), qc.invalidateQueries({ queryKey: ['roles'] })),
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (roles.isLoading || perms.isLoading) return <Loading />;
  const modules = [...new Set(perms.data?.map((p) => p.module))];
  const dirty = role && (draft.size !== role.permissions.length || role.permissions.some((p) => !draft.has(p)));

  return (
    <div>
      <PageHeader eyebrow="Administración" title="Roles y permisos" subtitle="Asigne qué puede hacer cada rol. La autorización se valida siempre en el servidor." />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit p-2">
          {roles.data?.map((r) => (
            <button key={r.id} onClick={() => setRoleId(r.id)} className={clsx('flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition', r.id === role?.id ? 'bg-ink-900 text-white' : 'hover:bg-ink-50')}>
              <span className="font-bold">{r.name}</span>
              <span className={clsx('text-xs', r.id === role?.id ? 'text-ink-300' : 'text-ink-500')}>{r.userCount} usuarios</span>
            </button>
          ))}
        </Card>
        {role && (
          <Card>
            <CardHeader
              icon={<ShieldCheck className="h-5 w-5" />}
              title={`Permisos de ${role.name}`}
              subtitle={`${draft.size} permisos asignados`}
              actions={
                <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                  Guardar cambios
                </Button>
              }
            />
            <div className="divide-y divide-ink-100">
              {modules.map((m) => (
                <div key={m} className="p-5">
                  <h4 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-ink-500">{m}</h4>
                  <div className="grid gap-2 md:grid-cols-2">
                    {perms.data?.filter((p) => p.module === m).map((p) => {
                      const blocked = role.forbidden.includes(p.code);
                      const checked = draft.has(p.code);
                      return (
                        <label key={p.code} className={clsx('flex items-start gap-3 rounded-xl border p-3 transition', blocked ? 'cursor-not-allowed border-ink-100 bg-ink-50 opacity-60' : checked ? 'cursor-pointer border-brand-300 bg-brand-50/50' : 'cursor-pointer border-ink-200 hover:border-ink-300')}>
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 accent-brand-500"
                            disabled={blocked}
                            checked={checked}
                            onChange={(e) =>
                              setDraft((d) => {
                                const n = new Set(d);
                                if (e.target.checked) n.add(p.code);
                                else n.delete(p.code);
                                return n;
                              })
                            }
                          />
                          <div>
                            <div className="text-sm font-semibold">{p.description}</div>
                            <div className="flex items-center gap-1 font-mono text-[11px] text-ink-500">
                              {p.code} {blocked && <><Lock className="h-3 w-3" /> no permitido para este rol</>}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
