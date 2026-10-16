import { HttpError } from '../errors/http-error';
import { DepartmentModel, RoomModel } from '../models/organization.model';
import { AssetModel, ProductModel } from '../models/inventory.model';
import { TicketModel } from '../models/ticket.model';
import { UserModel, type PublicUser } from '../models/user.model';
import { normalizeForSearch } from './article.service';
import { changeAsset, registerAsset } from './asset.service';
import { createProduct, type ProductInput } from './catalog.service';
import { DEMO_EMAILS } from './data-origin';
import { createDepartment, createRoom, setPersonLocation } from './organization.service';
import { issue, receive, returnUnits } from './stock.service';
import { changeStatus, createTicket } from './ticket.service';

/**
 * A fictitious company for presentations and screenshots: departments, rooms, a small catalog,
 * tagged equipment and stock scenarios. Everything goes through the application services, acting
 * as the reserved demo accounts, so movements are demonstration data with real history.
 *
 * Idempotent: departments, rooms and products are found by name or SKU, assets by tag, tickets by
 * requester and title, and every movement has a stable operation key, so running it again changes
 * nothing. Only the reserved demo accounts get a department, and only when they have none.
 * Brands and models are examples to fill the demo, not a statement about real availability.
 */

export interface InventoryPeople {
  requester: PublicUser;
  tech: PublicUser;
  manager?: PublicUser;
  requester2?: PublicUser;
  tech2?: PublicUser;
}

const STRUCTURE: { name: string; code: string; rooms: { name: string; floor: string }[] }[] = [
  { name: 'Financeiro', code: 'FIN', rooms: [{ name: 'Sala 203', floor: '2' }] },
  { name: 'Recursos Humanos', code: 'RH', rooms: [{ name: 'Sala 105', floor: '1' }] },
  { name: 'Administração', code: 'ADM', rooms: [{ name: 'Sala 301', floor: '3' }] },
  { name: 'Tecnologia da Informação', code: 'TI', rooms: [{ name: 'Sala 110', floor: '1' }] },
  { name: 'Comercial', code: 'COM', rooms: [{ name: 'Sala 205', floor: '2' }] },
];

const PRODUCTS: (ProductInput & { receive?: number })[] = [
  { sku: 'TEC-K120', name: 'Teclado Logitech K120', type: 'teclado', brand: 'Logitech', model: 'K120', tracking: 'quantity', minStock: 3, attributes: { layout: 'ABNT2', connection: 'USB', wireless: false, switchType: 'Membrana' }, receive: 6 },
  { sku: 'MOU-M90', name: 'Mouse Logitech M90', type: 'mouse', brand: 'Logitech', model: 'M90', tracking: 'quantity', minStock: 3, attributes: { connection: 'USB', wireless: false, dpi: 1000 }, receive: 8 },
  { sku: 'MOU-M170', name: 'Mouse Logitech M170', type: 'mouse', brand: 'Logitech', model: 'M170', tracking: 'quantity', minStock: 2, attributes: { connection: 'Receptor USB', wireless: true }, receive: 4 },
  { sku: 'CAB-HDMI-2M', name: 'Cabo HDMI 2 m', type: 'cabo', tracking: 'quantity', minStock: 5, attributes: { connector: 'HDMI', lengthM: 2 }, receive: 12 },
  { sku: 'SSD-KNG-480', name: 'SSD Kingston A400 480 GB', type: 'ssd', brand: 'Kingston', model: 'A400', tracking: 'quantity', minStock: 2, attributes: { capacityGb: 480, interface: 'SATA', formFactor: '2,5"' }, receive: 2 },
  { sku: 'HST-USB-DEMO', name: 'Headset USB (modelo demonstrativo)', type: 'headset', tracking: 'quantity', minStock: 3, attributes: { connection: 'USB', wireless: false }, receive: 1 },
  { sku: 'MON-P2422H', name: 'Monitor Dell P2422H', type: 'monitor', brand: 'Dell', model: 'P2422H', tracking: 'asset', minStock: 1, attributes: { sizeInches: 24, resolution: '1920x1080', videoInputs: 'HDMI, DisplayPort' } },
  { sku: 'NB-LAT-3440', name: 'Notebook Dell Latitude 3440', type: 'notebook', brand: 'Dell', model: 'Latitude 3440', tracking: 'asset', minStock: 1, attributes: { processor: 'Intel Core i5', ramGb: 16, storageGb: 512 } },
  { sku: 'PC-OPT-7010', name: 'Computador Dell OptiPlex 7010', type: 'computador', brand: 'Dell', model: 'OptiPlex 7010', tracking: 'asset', attributes: { processor: 'Intel Core i5', ramGb: 8, storageGb: 256 } },
];

const KEY = (name: string) => `demo-inventory-v1:${name}`;

export async function seedDemoInventory(people: InventoryPeople): Promise<string[]> {
  const log: string[] = [];
  for (const person of Object.values(people)) {
    if (person && !DEMO_EMAILS.has(person.email)) throw new Error(`Only the reserved demo accounts can be used (${person.email})`);
  }

  // ---------- Company structure ----------
  const place: Record<string, { departmentId: string; roomId: string }> = {};
  for (const entry of STRUCTURE) {
    let department = await DepartmentModel.findOne({ nameKey: normalizeForSearch(entry.name) });
    if (!department) {
      await createDepartment({ name: entry.name, code: entry.code });
      department = await DepartmentModel.findOne({ nameKey: normalizeForSearch(entry.name) });
      log.push(`departamento ${entry.name}: criado`);
    }
    for (const room of entry.rooms) {
      let found = await RoomModel.findOne({ department: department!._id, nameKey: normalizeForSearch(room.name) });
      if (!found) {
        await createRoom({ departmentId: department!.id, name: room.name, floor: room.floor });
        found = await RoomModel.findOne({ department: department!._id, nameKey: normalizeForSearch(room.name) });
        log.push(`sala ${entry.name} — ${room.name}: criada`);
      }
      place[entry.code] = { departmentId: department!.id, roomId: found!.id };
    }
  }
  const where = (code: string) => place[code];

  // Where the demo people work (only if not set yet).
  const workplaces: [PublicUser | undefined, string, string][] = [
    [people.requester2, 'FIN', 'Analista financeira'],
    [people.requester, 'RH', 'Analista de recursos humanos'],
    [people.tech, 'TI', 'Analista de suporte'],
    [people.tech2, 'TI', 'Analista de suporte'],
    [people.manager, 'ADM', 'Gestora de TI'],
  ];
  for (const [person, code, jobTitle] of workplaces) {
    if (!person) continue;
    const user = await UserModel.findById(person.id).select('department');
    if (user?.department) continue;
    await setPersonLocation(person.id, { ...where(code), jobTitle });
    log.push(`${person.name}: ${code}`);
  }

  // ---------- Catalog and initial stock ----------
  const products: Record<string, string> = {};
  for (const { receive: units, ...input } of PRODUCTS) {
    let product = await ProductModel.findOne({ sku: input.sku });
    if (!product) {
      await createProduct(input, people.tech);
      product = await ProductModel.findOne({ sku: input.sku });
      log.push(`material ${input.name}: cadastrado`);
    }
    products[input.sku!] = product!.id;
    if (units) await receive(product!.id, { operationId: KEY(`receipt:${input.sku}`), quantity: units, reason: 'Estoque inicial da demonstração' }, people.tech);
  }

  // ---------- Tagged equipment ----------
  const assets: Record<string, string> = {};
  const register = async (tag: string, sku: string, inUse?: { code: string; holder?: PublicUser }) => {
    const existing = await AssetModel.findOne({ assetTag: tag });
    if (existing) { assets[tag] = existing.id; return; }
    const result = await registerAsset({
      operationId: KEY(`asset:${tag}`), productId: products[sku], assetTag: tag, status: inUse ? 'in_use' : 'available',
      ...(inUse && { ...where(inUse.code), holderId: inUse.holder?.id ?? null }),
    }, people.tech);
    assets[tag] = result.movement.asset!.toString();
    log.push(`patrimônio ${tag}: cadastrado`);
  };
  await register('PAT-0001', 'PC-OPT-7010', { code: 'FIN', holder: people.requester2 ?? people.requester });
  await register('PAT-0002', 'MON-P2422H', { code: 'RH', holder: people.requester });
  await register('PAT-0003', 'NB-LAT-3440', { code: 'ADM', holder: people.manager });
  await register('PAT-0004', 'MON-P2422H');
  await register('PAT-0005', 'NB-LAT-3440');

  const ticketFor = async (requester: PublicUser, title: string, description: string, code: string, affected?: string) => {
    const existing = await TicketModel.findOne({ requester: requester.id, title });
    if (existing) return existing.id;
    const ticket = await createTicket({
      title, description, category: 'hardware', priority: 'media',
      intake: { answers: [{ key: 'equipment', answer: affected ? 'Monitor' : 'Periférico (mouse, teclado, fone)' }, { key: 'powersOn', answer: 'Sim' }] },
      location: where(code), affectedAssetId: affected ?? null,
    }, requester);
    const started = await changeStatus(ticket.id, 'em_andamento', people.tech, ticket.revision);
    log.push(`chamado ${title}: aberto e em atendimento`);
    return started.id;
  };

  // 1. Broken keyboard in Finance, room 203: one K120 delivered, the old one taken back as defective.
  const maria = people.requester2 ?? people.requester;
  const keyboardTicket = await ticketFor(maria, 'Teclado parou de funcionar', 'Várias teclas do teclado não respondem desde hoje cedo. Já troquei de porta USB.', 'FIN');
  await issue(products['TEC-K120'], { operationId: KEY('scenario:keyboard-issue'), quantity: 1, ticketId: keyboardTicket, recipientId: maria.id, ...where('FIN'), reason: 'Substituição do teclado com defeito' }, people.tech);
  await returnUnits(products['TEC-K120'], { operationId: KEY('scenario:keyboard-defective'), quantity: 1, condition: 'defective', ticketId: keyboardTicket, recipientId: maria.id, ...where('FIN'), reason: 'Teclado antigo com teclas sem resposta' }, people.tech);

  // 2. A mouse delivered to a person in HR, without a ticket.
  await issue(products['MOU-M90'], { operationId: KEY('scenario:mouse-issue'), quantity: 1, recipientId: people.requester.id, ...where('RH'), reason: 'Mouse novo para a estação de trabalho' }, people.tech2 ?? people.tech);

  // 3. HR monitor sent to maintenance from a ticket.
  const monitorTicket = await ticketFor(people.requester, 'Monitor do RH piscando', 'O monitor da minha mesa pisca a cada poucos segundos e às vezes apaga.', 'RH', assets['PAT-0002']);
  const monitor = await AssetModel.findById(assets['PAT-0002']);
  if (monitor?.status === 'in_use') {
    await changeAsset(assets['PAT-0002'], 'asset_maintenance', { operationId: KEY('scenario:monitor-maintenance'), ticketId: monitorTicket, reason: 'Imagem piscando; enviado para avaliação' }, people.tech);
    log.push('PAT-0002: enviado para manutenção');
  }

  // 4. A notebook moved from Administration to Sales.
  const notebook = await AssetModel.findById(assets['PAT-0003']);
  if (notebook?.location?.departmentName === 'Administração') {
    await changeAsset(assets['PAT-0003'], 'asset_transfer', { operationId: KEY('scenario:notebook-transfer'), ...where('COM'), holderId: null, reason: 'Remanejamento para a equipe comercial' }, people.tech);
    log.push('PAT-0003: transferido para o Comercial');
  }

  // 5. The demo headset stays below its minimum (1 unit, minimum 3): nothing to do.
  // 6. A delivery above the balance is refused by the same rule as the app; nothing is recorded.
  try {
    await issue(products['SSD-KNG-480'], { operationId: KEY('scenario:ssd-too-many'), quantity: 5, ...where('TI'), reason: 'Tentativa acima do saldo' }, people.tech);
    log.push('ATENÇÃO: a retirada acima do saldo foi aceita');
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'INSUFFICIENT_STOCK') throw error;
    log.push('retirada de 5 SSD com 2 disponíveis: recusada (estoque insuficiente)');
  }
  return log;
}
