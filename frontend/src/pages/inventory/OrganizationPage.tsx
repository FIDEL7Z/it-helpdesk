import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { FormMessage, InventoryNav, LocationFields } from '../../components/inventory/InventoryUi'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useResource } from '../../hooks/useResource'
import { ApiError } from '../../services/api'
import {
  createDepartment,
  createRoom,
  getOrganization,
  listPeople,
  setPersonLocation,
  updateDepartment,
  updateRoom,
  type Department,
  type Person,
} from '../../services/organization'
import { getErrorMessage } from '../../utils/errors'

/** Departments, rooms and where people work. Managers change them; nothing is deleted, only deactivated. */
export function OrganizationPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <Organization canManage={can(user?.role, 'org:manage')} /> : <Navigate to="/dashboard" replace />
}

const messageFor = (error: unknown) => error instanceof ApiError && error.status === 409 ? 'Já existe um cadastro com este nome ou código.' : getErrorMessage(error)

function Organization({ canManage }: { canManage: boolean }) {
  useDocumentTitle('Departamentos e salas')
  const org = useResource((signal) => getOrganization(signal, canManage), [canManage])
  const people = useResource((signal) => listPeople(signal), [])
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [name, setName] = useState('')

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(null)
    try {
      await action()
      setMessage({ type: 'success', text: success })
      org.reload()
      people.reload()
    } catch (error) {
      setMessage({ type: 'error', text: messageFor(error) })
    }
  }

  async function addDepartment(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    await run(() => createDepartment({ name: name.trim() }), `Departamento ${name.trim()} cadastrado.`)
    setName('')
  }

  return (
    <section className="page inventory-page">
      <header className="page__header">
        <h1 className="page__title">Departamentos e salas</h1>
        <p className="page__subtitle">Onde os equipamentos ficam e onde os problemas acontecem. {canManage ? 'Cadastros desativados continuam no histórico.' : 'Somente a gestão altera esta estrutura.'}</p>
      </header>
      <InventoryNav />
      <FormMessage message={message} />

      {canManage && (
        <form className="form card form--inline" onSubmit={addDepartment}>
          <div className="field">
            <label htmlFor="new-department" className="field__label">Novo departamento</label>
            <input id="new-department" className="field__input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Financeiro" />
          </div>
          <button type="submit" className="button button--primary">Cadastrar</button>
        </form>
      )}

      {org.error ? <div className="alert alert--error" role="alert"><p>{org.error}</p></div> : !org.data ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando estrutura...</div>
      ) : (
        <div className="org-grid">
          {org.data.departments.map((department) => (
            <DepartmentCard key={department.id} department={department} canManage={canManage} run={run} />
          ))}
        </div>
      )}

      <section className="card card--table" aria-labelledby="people-title">
        <h2 id="people-title" className="card__title card__title--padded">Pessoas e onde trabalham</h2>
        {!people.data ? <p className="text-muted">Carregando pessoas...</p> : (
          <table className="ticket-table inventory-table">
            <thead><tr><th scope="col">Pessoa</th><th scope="col">Função</th><th scope="col">Departamento e sala</th>{canManage && <th scope="col"><span className="sr-only">Ação</span></th>}</tr></thead>
            <tbody>
              {people.data.people.map((person) => (
                <PersonRow key={person.id} person={person} departments={org.data?.departments ?? []} canManage={canManage} run={run} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  )
}

function DepartmentCard({ department, canManage, run }: { department: Department; canManage: boolean; run: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [room, setRoom] = useState('')
  return (
    <section className={`card org-card${department.active ? '' : ' org-card--inactive'}`} aria-labelledby={`dept-${department.id}`}>
      <div className="card__header-row">
        <h2 id={`dept-${department.id}`} className="card__title">{department.name}{department.code ? ` · ${department.code}` : ''}</h2>
        {!department.active && <span className="origin-tag">Inativo</span>}
      </div>
      {department.rooms.length === 0 ? <p className="text-muted">Nenhuma sala cadastrada.</p> : (
        <ul className="plain-list">
          {department.rooms.map((r) => (
            <li key={r.id}>
              {r.name}{r.floor ? ` · ${r.floor}º andar` : ''}{!r.active && <span className="origin-tag">Inativa</span>}
              {canManage && <button type="button" className="button button--ghost button--small" onClick={() => run(() => updateRoom(r.id, { active: !r.active }), `${r.name} ${r.active ? 'desativada' : 'reativada'}.`)}>{r.active ? 'Desativar' : 'Reativar'}</button>}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="form__row org-card__actions">
          <div className="field">
            <label htmlFor={`room-${department.id}`} className="sr-only">Nova sala em {department.name}</label>
            <input id={`room-${department.id}`} className="field__input" value={room} maxLength={80} onChange={(e) => setRoom(e.target.value)} placeholder="Nova sala, ex.: Sala 203" disabled={!department.active} />
          </div>
          <button type="button" className="button button--secondary button--small" disabled={!department.active || !room.trim()}
            onClick={() => run(() => createRoom({ departmentId: department.id, name: room.trim() }), `${room.trim()} cadastrada em ${department.name}.`).then(() => setRoom(''))}>Adicionar sala</button>
          <button type="button" className="button button--ghost button--small" onClick={() => run(() => updateDepartment(department.id, { active: !department.active }), `${department.name} ${department.active ? 'desativado' : 'reativado'}.`)}>
            {department.active ? 'Desativar departamento' : 'Reativar'}
          </button>
        </div>
      )}
    </section>
  )
}

function PersonRow({ person, departments, canManage, run }: { person: Person; departments: Department[]; canManage: boolean; run: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [place, setPlace] = useState({ departmentId: person.department?.id ?? '', roomId: person.room?.id ?? '' })
  const [jobTitle, setJobTitle] = useState(person.jobTitle ?? '')
  return (
    <tr>
      <td data-label="Pessoa" className="ticket-table__title">{person.name}</td>
      <td data-label="Função">{person.jobTitle ?? '—'}</td>
      <td data-label="Departamento e sala">
        {editing ? (
          <div className="person-location">
            <LocationFields idPrefix={`person-${person.id}`} departments={departments} value={place} onChange={setPlace} legend={`Local de ${person.name}`} />
            <div className="field">
              <label htmlFor={`job-${person.id}`} className="field__label">Função</label>
              <input id={`job-${person.id}`} className="field__input" value={jobTitle} maxLength={80} onChange={(e) => setJobTitle(e.target.value)} />
            </div>
            <div className="form__actions">
              <button type="button" className="button button--primary button--small" onClick={() => run(() => setPersonLocation(person.id, { departmentId: place.departmentId || null, roomId: place.roomId || null, jobTitle: jobTitle.trim() || null }), `Local de ${person.name} atualizado.`).then(() => setEditing(false))}>Salvar</button>
              <button type="button" className="button button--ghost button--small" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </div>
        ) : person.department ? `${person.department.name}${person.room ? ` — ${person.room.name}` : ''}` : <span className="text-muted">Não informado</span>}
      </td>
      {canManage && <td data-label="Ação">{!editing && <button type="button" className="button button--secondary button--small" onClick={() => setEditing(true)}>Alterar</button>}</td>}
    </tr>
  )
}
