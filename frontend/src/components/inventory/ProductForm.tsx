import { useState, type FormEvent } from 'react'
import { createProduct, updateProduct, type Product, type ProductType, type Tracking, type TypeCatalog } from '../../services/inventory'
import { getErrorMessage } from '../../utils/errors'
import { inventoryErrorMessage } from '../../services/inventory'
import { ApiError } from '../../services/api'

type Values = {
  name: string; type: ProductType; tracking: Tracking; sku: string; brand: string; model: string
  unit: string; minStock: string; description: string; attributes: Record<string, string | boolean>
}

const fromProduct = (product?: Product): Values => ({
  name: product?.name ?? '', type: product?.type ?? 'teclado', tracking: product?.tracking ?? 'quantity', sku: product?.sku ?? '',
  brand: product?.brand ?? '', model: product?.model ?? '', unit: product?.unit ?? 'unidade', minStock: String(product?.minStock ?? 0),
  description: product?.description ?? '',
  attributes: Object.fromEntries(Object.entries(product?.attributes ?? {}).map(([key, value]) => [key, typeof value === 'boolean' ? value : String(value)])),
})

/** Registers or edits a catalog entry. Type and tracking mode are chosen once, at registration. */
export function ProductForm({ catalog, product, onSaved, onCancel }: {
  catalog: TypeCatalog
  product?: Product
  onSaved: (product: Product) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Values>(() => fromProduct(product))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }))
  const specs = catalog[values.type].attributes

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (values.name.trim().length < 2) { setError('Informe o nome do material.'); return }
    const attributes = Object.fromEntries(specs.flatMap((spec): [string, string | number | boolean][] => {
      const raw = values.attributes[spec.key]
      if (raw === undefined || raw === '') return []
      if (spec.kind === 'bool') return [[spec.key, raw === true]]
      if (spec.kind === 'int' || spec.kind === 'number') return [[spec.key, Number(String(raw).replace(',', '.'))]]
      return [[spec.key, String(raw)]]
    }))
    const body = {
      name: values.name.trim(), sku: values.sku.trim() || null, brand: values.brand.trim() || null, model: values.model.trim() || null,
      description: values.description.trim() || null, minStock: Number(values.minStock) || 0, attributes,
      ...(values.tracking === 'quantity' && { unit: values.unit }),
    }
    setSaving(true)
    setError(null)
    try {
      const saved = product
        ? await updateProduct(product.id, { ...body, expectedRevision: product.revision })
        : await createProduct({ ...body, type: values.type, tracking: values.tracking })
      onSaved(saved.product)
    } catch (caught) {
      setError(inventoryErrorMessage(caught, caught instanceof ApiError && caught.status === 409
        ? 'Já existe um material com este SKU, ou o cadastro foi alterado por outra pessoa. Revise e tente de novo.'
        : getErrorMessage(caught)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form card product-form" onSubmit={submit} noValidate aria-labelledby="product-form-title">
      <h2 id="product-form-title" className="card__title">{product ? `Editar ${product.name}` : 'Novo material'}</h2>
      {error && <p className="alert alert--error" role="alert">{error}</p>}
      <div className="form__row">
        <div className="field">
          <label htmlFor="product-name" className="field__label">Nome</label>
          <input id="product-name" className="field__input" value={values.name} maxLength={120} required onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Teclado Logitech K120" />
        </div>
        <div className="field">
          <label htmlFor="product-sku" className="field__label">Código interno (SKU)</label>
          <input id="product-sku" className="field__input" value={values.sku} maxLength={40} onChange={(e) => set('sku', e.target.value)} placeholder="Opcional, único" />
        </div>
      </div>
      <div className="form__row">
        <div className="field">
          <label htmlFor="product-type" className="field__label">Tipo</label>
          <select id="product-type" className="field__input field__select" value={values.type} disabled={Boolean(product)}
            onChange={(e) => setValues((v) => ({ ...v, type: e.target.value as ProductType, attributes: {} }))}>
            {(Object.keys(catalog) as ProductType[]).map((type) => <option key={type} value={type}>{catalog[type].label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="product-tracking" className="field__label">Controle</label>
          <select id="product-tracking" className="field__input field__select" value={values.tracking} disabled={Boolean(product)} aria-describedby="product-tracking-hint"
            onChange={(e) => set('tracking', e.target.value as Tracking)}>
            <option value="quantity">Por quantidade</option>
            <option value="asset">Por patrimônio (cada unidade identificada)</option>
          </select>
          <p id="product-tracking-hint" className="field__hint">{product ? 'Não muda depois do cadastro.' : 'Periféricos e cabos: quantidade. Notebooks, monitores e impressoras: patrimônio.'}</p>
        </div>
      </div>
      <div className="form__row">
        <div className="field">
          <label htmlFor="product-brand" className="field__label">Marca</label>
          <input id="product-brand" className="field__input" value={values.brand} maxLength={60} onChange={(e) => set('brand', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="product-model" className="field__label">Modelo</label>
          <input id="product-model" className="field__input" value={values.model} maxLength={60} onChange={(e) => set('model', e.target.value)} />
        </div>
      </div>
      <div className="form__row">
        {values.tracking === 'quantity' && (
          <div className="field">
            <label htmlFor="product-unit" className="field__label">Unidade</label>
            <select id="product-unit" className="field__input field__select" value={values.unit} onChange={(e) => set('unit', e.target.value)}>
              {['unidade', 'metro', 'caixa', 'pacote'].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="product-min" className="field__label">Estoque mínimo</label>
          <input id="product-min" className="field__input" type="number" min={0} value={values.minStock} onChange={(e) => set('minStock', e.target.value)} aria-describedby="product-min-hint" />
          <p id="product-min-hint" className="field__hint">Abaixo disso, o material aparece como abaixo do mínimo.</p>
        </div>
      </div>
      {specs.length > 0 && (
        <fieldset className="product-form__attributes">
          <legend className="field__label">Características (opcionais)</legend>
          <div className="form__row form__row--wrap">
            {specs.map((spec) => {
              const fieldId = `product-attr-${spec.key}`
              const value = values.attributes[spec.key] ?? ''
              const change = (next: string | boolean) => setValues((v) => ({ ...v, attributes: { ...v.attributes, [spec.key]: next } }))
              if (spec.kind === 'bool') return (
                <label key={spec.key} className="checkbox" htmlFor={fieldId}>
                  <input id={fieldId} type="checkbox" checked={value === true} onChange={(e) => change(e.target.checked)} /> {spec.label}
                </label>
              )
              return (
                <div key={spec.key} className="field">
                  <label htmlFor={fieldId} className="field__label">{spec.label}{'unit' in spec && spec.unit ? ` (${spec.unit})` : ''}</label>
                  {spec.kind === 'enum' ? (
                    <select id={fieldId} className="field__input field__select" value={String(value)} onChange={(e) => change(e.target.value)}>
                      <option value="">Não informado</option>
                      {spec.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input id={fieldId} className="field__input" value={String(value)} inputMode={spec.kind === 'text' ? undefined : 'decimal'}
                      maxLength={spec.kind === 'text' ? spec.maxLength : 12} onChange={(e) => change(e.target.value)} />
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="product-description" className="field__label">Descrição</label>
        <textarea id="product-description" className="field__input" rows={2} value={values.description} maxLength={1000} onChange={(e) => set('description', e.target.value)} />
      </div>
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Salvando...' : product ? 'Salvar alterações' : 'Cadastrar material'}</button>
        <button type="button" className="button button--ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  )
}
