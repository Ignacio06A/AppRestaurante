import { FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { Button, Field, Input, Modal } from './ui';

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8 || mismatch) return;
    setLoading(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success('Contraseña actualizada');
      setCurrent('');
      setNext('');
      setConfirm('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Cambiar contraseña" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Contraseña actual">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label="Nueva contraseña" error={next && next.length < 8 ? 'Mínimo 8 caracteres' : null}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required autoComplete="new-password" />
        </Field>
        <Field label="Confirmar nueva contraseña" error={mismatch ? 'Las contraseñas no coinciden' : null}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={loading} disabled={next.length < 8 || mismatch || !current}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
