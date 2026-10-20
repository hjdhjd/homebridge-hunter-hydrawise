/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hap.helpers.ts: A hand-built HAP test-double - the Service and Characteristic marker namespaces, TestCharacteristic, TestService, and TestAccessory - that
 * mirrors only the HAP surface the plugin actually touches. homebridge-plugin-utils' REAL acquireService / validService / getServiceName / setServiceName run
 * unmodified against these doubles, so a REAL HydrawiseController is constructed end to end with no live HAP runtime.
 *
 * The doubles carry the identity surface those helpers key on, so naming behaves as it does against real HAP. TestService exposes the whole service namespace as
 * cross-kind statics, which is what the helpers' name-set initializer reads off a service's constructor to decide whether a kind supports the ConfiguredName and
 * Name characteristics, and TestCharacteristic - the single wrapper class every characteristic instantiates, and therefore the constructor the helpers recover
 * from a service's first characteristic - exposes the name-characteristic kinds as statics. A Valve consequently takes both name characteristics and an
 * IrrigationSystem takes Name alone, exactly as against real HAP, and getServiceName reads back what setServiceName wrote.
 *
 * Every characteristic write is recorded on its service along with the kind written, so a test can assert that a particular characteristic was or was not
 * written across a window without reasoning about the routine writes a polling pass performs.
 *
 * Consumed surface (swept from homebridge-plugin-utils/src/service.ts and the plugin source): a service exposes UUID, subtype, displayName (mutable),
 * characteristics (the public array getCharacteristicConstructor destructures), optionalCharacteristics, addOptionalCharacteristic, testCharacteristic,
 * getCharacteristic, updateCharacteristic, removeCharacteristic, and removeService's target shape; a characteristic exposes UUID, value, updateValue,
 * onGet, onSet, and the triggerGet / triggerSet test knobs; an accessory exposes context, displayName, updateDisplayName, _associatedHAPAccessory,
 * services, addService, getService, getServiceById, and removeService. The status error a refusal throws is doubled here too, as TestHapStatusError.
 */
import type { HAPStatus } from "homebridge-plugin-utils";

// Identity classes for the HAP Characteristic kinds the plugin touches. Each kind is its own marker class carrying the UUID identity string HAP exposes on
// every characteristic, and, where production compares against named constants, the HAP integer constants as statics. A hapKind field names the kind for
// readability in source, but these classes are never constructed - production passes the class itself as a key into getCharacteristic / updateCharacteristic,
// and the value is looked up by class identity - so hapKind never materializes on a live instance here the way it does on the service markers below, which
// acquireService constructs directly and so surface their kind in inspect output on failure.
class ActiveCharacteristicType {

  public static readonly ACTIVE = 1;
  public static readonly INACTIVE = 0;
  public static readonly UUID = "Active";
  public readonly hapKind = "Active" as const;
}

class ConfiguredNameCharacteristicType {

  public static readonly UUID = "ConfiguredName";
  public readonly hapKind = "ConfiguredName" as const;
}

class FirmwareRevisionCharacteristicType {

  public static readonly DEFAULT_VALUE = "0.0.0";
  public static readonly UUID = "FirmwareRevision";
  public readonly hapKind = "FirmwareRevision" as const;
}

class InUseCharacteristicType {

  public static readonly IN_USE = 1;
  public static readonly NOT_IN_USE = 0;
  public static readonly UUID = "InUse";
  public readonly hapKind = "InUse" as const;
}

class IsConfiguredCharacteristicType {

  public static readonly CONFIGURED = 1;
  public static readonly NOT_CONFIGURED = 0;
  public static readonly UUID = "IsConfigured";
  public readonly hapKind = "IsConfigured" as const;
}

class ManufacturerCharacteristicType {

  public static readonly DEFAULT_VALUE = "Default-Manufacturer";
  public static readonly UUID = "Manufacturer";
  public readonly hapKind = "Manufacturer" as const;
}

class ModelCharacteristicType {

  public static readonly DEFAULT_VALUE = "Default-Model";
  public static readonly UUID = "Model";
  public readonly hapKind = "Model" as const;
}

class NameCharacteristicType {

  public static readonly UUID = "Name";
  public readonly hapKind = "Name" as const;
}

class OnCharacteristicType {

  public static readonly UUID = "On";
  public readonly hapKind = "On" as const;
}

class ProgramModeCharacteristicType {

  public static readonly NO_PROGRAM_SCHEDULED = 0;
  public static readonly PROGRAM_SCHEDULED = 1;
  public static readonly PROGRAM_SCHEDULED_MANUAL_MODE = 2;
  public static readonly UUID = "ProgramMode";
  public readonly hapKind = "ProgramMode" as const;
}

class RemainingDurationCharacteristicType {

  public static readonly UUID = "RemainingDuration";
  public readonly hapKind = "RemainingDuration" as const;
}

class SerialNumberCharacteristicType {

  public static readonly DEFAULT_VALUE = "Default-SerialNumber";
  public static readonly UUID = "SerialNumber";
  public readonly hapKind = "SerialNumber" as const;
}

class ServiceLabelIndexCharacteristicType {

  public static readonly UUID = "ServiceLabelIndex";
  public readonly hapKind = "ServiceLabelIndex" as const;
}

// The fault characteristic HAP permits on an irrigation system, carrying the two values the specification defines. It is optional on that service, which is what
// lets the runtime publish it only where it has something to say and withdraw it wherever it does not.
class StatusFaultCharacteristicType {

  public static readonly GENERAL_FAULT = 1;
  public static readonly NO_FAULT = 0;
  public static readonly UUID = "StatusFault";
  public readonly hapKind = "StatusFault" as const;
}

class ServiceLabelNamespaceCharacteristicType {

  public static readonly ARABIC_NUMERALS = 1;
  public static readonly DOTS = 0;
  public static readonly UUID = "ServiceLabelNamespace";
  public readonly hapKind = "ServiceLabelNamespace" as const;
}

class SetDurationCharacteristicType {

  public static readonly UUID = "SetDuration";
  public readonly hapKind = "SetDuration" as const;
}

class ValveTypeCharacteristicType {

  public static readonly GENERIC_VALVE = 0;
  public static readonly IRRIGATION = 1;
  public static readonly SHOWER_HEAD = 2;
  public static readonly UUID = "ValveType";
  public static readonly WATER_FAUCET = 3;
  public readonly hapKind = "ValveType" as const;
}

/**
 * The HAP Characteristic namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production
 * reaches for one.
 */
export const Characteristic = {

  Active: ActiveCharacteristicType,
  ConfiguredName: ConfiguredNameCharacteristicType,
  FirmwareRevision: FirmwareRevisionCharacteristicType,
  InUse: InUseCharacteristicType,
  IsConfigured: IsConfiguredCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  Name: NameCharacteristicType,
  On: OnCharacteristicType,
  ProgramMode: ProgramModeCharacteristicType,
  RemainingDuration: RemainingDurationCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  ServiceLabelIndex: ServiceLabelIndexCharacteristicType,
  ServiceLabelNamespace: ServiceLabelNamespaceCharacteristicType,
  SetDuration: SetDurationCharacteristicType,
  StatusFault: StatusFaultCharacteristicType,
  ValveType: ValveTypeCharacteristicType
} as const;

/* The HAP status error double. Production reaches HAP's own HapStatusError through `api.hap` and binds it as the class a refusal is constructed from, so the platform
 * doubles hand the plugin this class in its place, carrying the one field the refusal rows read: the status it was constructed with.
 */
export class TestHapStatusError extends Error {

  public readonly hapStatus: HAPStatus;

  public constructor(status: HAPStatus) {

    super("HAP Status Error: " + status.toString());

    this.hapStatus = status;
    this.name = "HapStatusError";
  }
}

// The constructor-as-key shapes both namespaces expose. The argument list is intentionally permissive: the characteristic markers take no arguments, the service
// markers take HAP's (displayName?, subtype?) pair, and the alias must admit either when used as a Map key.
export type CharacteristicType = abstract new (...args: never[]) => object;
export type ServiceType = abstract new (...args: never[]) => object;

// A service kind as the real helpers' name-set initializer consumes it: a marker carrying the identity string it looks the kind up by.
type ServiceKindMarker = ServiceType & { readonly UUID: string };

/**
 * One recorded characteristic write: the kind that was written and the value it received. Assertions filter a service's log by kind, because a service
 * takes routine writes on every polling pass and a claim about one characteristic must not be disturbed by them.
 */
export interface CharacteristicWrite {

  readonly type: CharacteristicType;
  readonly value: unknown;
}

/**
 * One characteristic backing instance, owned by a TestService. Holds the last value written plus the optional onGet / onSet handlers production installs.
 * triggerGet / triggerSet are the test-side knobs that exercise the bound handlers without a real HAP request path. This is the ONLY characteristic class
 * the double instantiates, so it is what the real getCharacteristicConstructor recovers from a service's first characteristic - which is why the
 * name-characteristic kinds hang off it as statics, mirroring how HAP's Characteristic base class exposes its namespace.
 *
 * @param type        - the characteristic kind marker this instance backs.
 * @param recordWrite - callback invoked with each written value, so the owning service can log it against this kind.
 */
export class TestCharacteristic {

  public static readonly ConfiguredName = ConfiguredNameCharacteristicType;
  public static readonly Name = NameCharacteristicType;

  public readonly type: CharacteristicType;
  private currentValue: unknown;
  private getHandler: (() => unknown) | undefined = undefined;
  private readonly recordWrite: ((value: unknown) => void) | undefined;
  private setHandler: ((value: unknown) => Promise<void> | void) | undefined = undefined;

  public constructor(type: CharacteristicType, recordWrite?: (value: unknown) => void) {

    this.recordWrite = recordWrite;
    this.type = type;

    /* Seed the value HAP itself constructs this kind with, mirrored from the kind's own static. Only the AccessoryInformation string characteristics declare one -
     * every other kind starts null, matching HAP's own uninitialized default - and modeling them is not decoration: production READS the model characteristic
     * and branches on whether it still holds HAP's default, which is how it tells a brand-new accessory from one restored out of the cache. A double that
     * started every characteristic at null would send that branch down the wrong arm and let a broken implementation pass.
     */
    this.currentValue = (type as { DEFAULT_VALUE?: unknown }).DEFAULT_VALUE ?? null;
  }

  // The kind's identity string, mirrored from the type's static, matching how HAP exposes a UUID on a characteristic instance. The real acquireService compares
  // this against the name characteristics' UUIDs when it checks whether a service's optional set already carries them. The fallback is a non-empty sentinel for a
  // hand-rolled type outside the namespace.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-characteristic-kind";
  }

  // The most recently written value. Production reads this to decide behavior on its next pass - whether a characteristic still holds a sentinel default,
  // or what a prior write left cached - rather than to confirm a write it just made.
  public get value(): unknown {

    return this.currentValue;
  }

  // Write a value into the characteristic and record it against the owning service. Returns this so it chains in the production-typical service.updateCharacteristic
  // pattern.
  public updateValue(value: unknown): this {

    this.currentValue = value;
    this.recordWrite?.(value);

    return this;
  }

  // Install the production read handler. Tests inspect what was bound via triggerGet.
  public onGet(handler: () => unknown): this {

    this.getHandler = handler;

    return this;
  }

  // Install the production write handler. Tests drive it via triggerSet; the production handler runs as if HomeKit invoked it.
  public onSet(handler: (value: unknown) => Promise<void> | void): this {

    this.setHandler = handler;

    return this;
  }

  // Test-side trigger for the installed onGet handler. Falls through to the last-written value when no handler is bound, matching HAP's read-from-cache semantics.
  public async triggerGet(): Promise<unknown> {

    if(!this.getHandler) {

      return this.currentValue;
    }

    return this.getHandler();
  }

  // Test-side trigger for the installed onSet handler. After the handler resolves, the supplied value becomes the cached value, mirroring HAP's set-then-cache
  // behavior. The value lands through updateValue so a HomeKit-originated set is recorded like any other write.
  public async triggerSet(value: unknown): Promise<void> {

    if(this.setHandler) {

      await this.setHandler(value);
    }

    this.updateValue(value);
  }
}

/**
 * One service instance attached to a TestAccessory. Holds a Map of characteristic-kind -> TestCharacteristic so getCharacteristic returns the same
 * instance across calls (production binds onGet / onSet once and expects the binding to persist). characteristics is a PUBLIC ARRAY view because
 * acquireService's getCharacteristicConstructor destructures the first element to recover the Characteristic constructor and throws when none exists -
 * which is why each constructible service marker seeds one characteristic. displayName is MUTABLE because setServiceName assigns it on every acquire.
 * UUID mirrors the marker's static and is never empty, so no service collides with the empty-string entry the helpers' name sets carry for the HAP kinds
 * this double does not model.
 *
 * @param type        - the service kind marker this instance backs.
 * @param displayName - the service's initial display name.
 * @param subtype     - the service's subtype, when the kind is instantiated more than once on an accessory.
 */
export class TestService {

  /* The service namespace as cross-kind statics, mirroring how a real HAP service class inherits the whole Service namespace. The helpers' name-set initializer
   * reads these named properties off a service's constructor to build the UUID sets behind their ConfiguredName and Name predicates, so a service that could not
   * resolve its siblings would answer false for every kind. They live on the base every marker extends - and which is itself directly constructible - so every
   * service, marker or bare, presents the same view. That uniformity is what keeps outcomes stable: the initializer builds its sets ONCE PER PROCESS from the
   * first service it happens to see, so a namespace that varied by kind would make naming depend on the order services were created in. Static accessors rather
   * than fields, because the markers extend this class and so do not exist yet while this class body is evaluated.
   */
  public static get AccessoryInformation(): ServiceKindMarker {

    return AccessoryInformationServiceType;
  }

  public static get IrrigationSystem(): ServiceKindMarker {

    return IrrigationSystemServiceType;
  }

  public static get ServiceLabel(): ServiceKindMarker {

    return ServiceLabelServiceType;
  }

  public static get Switch(): ServiceKindMarker {

    return SwitchServiceType;
  }

  public static get Valve(): ServiceKindMarker {

    return ValveServiceType;
  }

  public displayName: string;
  public readonly subtype: string | undefined;
  public readonly type: ServiceType;
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();
  private readonly optionalTypes = new Set<CharacteristicType>();
  private readonly writeLog: CharacteristicWrite[] = [];

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.displayName = displayName;
    this.subtype = subtype;
    this.type = type;
  }

  // The service kind's identity string, mirrored from the type's static. Real HAP identifies kinds by UUID; the double uses the kind string, which is unique
  // within the namespace and legible in failures. The fallback is a non-empty sentinel for a hand-rolled type outside the namespace, so the returned UUID is
  // never empty.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-service-kind";
  }

  // The public array view of the materialized characteristics, mirroring HAP's Service.characteristics. Insertion order, so a marker's seed characteristic is
  // always first - exactly what the real getCharacteristicConstructor destructures.
  public get characteristics(): TestCharacteristic[] {

    return [...this.characteristicsByType.values()];
  }

  // The optional-characteristic view HAP exposes. The real acquireService reads it to decide whether a kind's supported name characteristics are already present,
  // and populates it through addOptionalCharacteristic for the kinds that support them.
  public get optionalCharacteristics(): TestCharacteristic[] {

    return [...this.optionalTypes].map(type => this.getCharacteristic(type));
  }

  // Every characteristic write this service has taken, in order, each carrying the kind that was written.
  public get writes(): readonly CharacteristicWrite[] {

    return [...this.writeLog];
  }

  // Fetch or lazily create the characteristic of the given kind. Lazy creation matches HAP, which instantiates required characteristics on first access. The
  // recorder handed to a new characteristic closes over its kind, so every write it takes lands in this service's log already labeled.
  public getCharacteristic(charType: CharacteristicType): TestCharacteristic {

    let char = this.characteristicsByType.get(charType);

    if(!char) {

      char = new TestCharacteristic(charType, (value: unknown): void => {

        this.writeLog.push({ type: charType, value });
      });

      this.characteristicsByType.set(charType, char);
    }

    return char;
  }

  // Write a value to the characteristic of the given kind. Returns this so chained production updates compile.
  public updateCharacteristic(charType: CharacteristicType, value: unknown): this {

    this.getCharacteristic(charType).updateValue(value);

    return this;
  }

  // Declare an optional characteristic, mirroring HAP's Service.addOptionalCharacteristic. HAP lazily materializes a permitted characteristic on first
  // access, but testCharacteristic is a pure has() check with no creation side effect of its own, so without materializing it here the double would
  // report the characteristic absent until some later getCharacteristic / onGet call created it. Materializing it now makes testCharacteristic report
  // it present immediately after this call, matching HAP's own behavior; getCharacteristic's own memoization is what guarantees any later access
  // returns this same instance, regardless of when it was first created.
  public addOptionalCharacteristic(charType: CharacteristicType): void {

    this.optionalTypes.add(charType);
    this.getCharacteristic(charType);
  }

  // Report whether the characteristic of the given kind has already been created, mirroring HAP's Service.testCharacteristic. Unlike getCharacteristic, this never
  // lazily creates - it is a pure predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }

  /* Drop a materialized characteristic, mirroring HAP's Service.removeCharacteristic. It takes the INSTANCE rather than the kind, exactly as HAP does, so
   * production's remove call reads here as it does against the real library - the caller looks the characteristic up and hands it over.
   *
   * An instance this service does not hold is a no-op, which is what a removal racing another removal looks like. The write log is deliberately left intact: it
   * records what production DID, and a removal does not unmake the writes that preceded it.
   */
  public removeCharacteristic(characteristic: TestCharacteristic): void {

    for(const [ type, candidate ] of this.characteristicsByType) {

      if(candidate === characteristic) {

        this.characteristicsByType.delete(type);
        this.optionalTypes.delete(type);

        return;
      }
    }
  }

  // The recorded writes for the given kinds, which is how a test asks whether a specific characteristic was written across a window.
  public writesFor(...types: CharacteristicType[]): CharacteristicWrite[] {

    return this.writeLog.filter(write => types.includes(write.type));
  }

  // Discard the recorded writes, so a test can open a window and observe exactly the writes performed within it.
  public clearWrites(): void {

    this.writeLog.length = 0;
  }
}

// The service marker classes. Each is a CONSTRUCTIBLE subclass of TestService carrying HAP's (displayName?, subtype?) constructor, because the real
// acquireService instantiates the namespace entry directly on its create branch and recovers the Characteristic constructor from the new service's first
// characteristic. Every marker therefore seeds at least its primary required characteristic at construction, so the first element always exists for
// getCharacteristicConstructor to recover.
class AccessoryInformationServiceType extends TestService {

  public static readonly UUID = "AccessoryInformation";
  public readonly hapKind = "AccessoryInformation" as const;

  public constructor(displayName = "", subtype?: string) {

    super(AccessoryInformationServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

class IrrigationSystemServiceType extends TestService {

  public static readonly UUID = "IrrigationSystem";
  public readonly hapKind = "IrrigationSystem" as const;

  public constructor(displayName = "", subtype?: string) {

    super(IrrigationSystemServiceType, displayName, subtype);

    this.getCharacteristic(ActiveCharacteristicType);
  }
}

class ServiceLabelServiceType extends TestService {

  public static readonly UUID = "ServiceLabel";
  public readonly hapKind = "ServiceLabel" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ServiceLabelServiceType, displayName, subtype);

    this.getCharacteristic(ServiceLabelNamespaceCharacteristicType);
  }
}

class SwitchServiceType extends TestService {

  public static readonly UUID = "Switch";
  public readonly hapKind = "Switch" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SwitchServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

class ValveServiceType extends TestService {

  public static readonly UUID = "Valve";
  public readonly hapKind = "Valve" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ValveServiceType, displayName, subtype);

    this.getCharacteristic(ActiveCharacteristicType);
  }
}

/**
 * The HAP Service namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production touches one.
 */
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  IrrigationSystem: IrrigationSystemServiceType,
  ServiceLabel: ServiceLabelServiceType,
  Switch: SwitchServiceType,
  Valve: ValveServiceType
} as const;

/**
 * One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append more.
 * getService / getServiceById mirror HAP's distinction between "the bare service of this type" and "the service of this type with a specific subtype".
 * The mutable context and displayName are the fields the production controller path reads and writes; the _associatedHAPAccessory mirror is retained for
 * HAP-shape parity because the display-name write assigns through it.
 *
 * @param displayName - the accessory's initial display name.
 * @param uuid        - the accessory's UUID.
 * @param category    - the accessory's HAP category, mirroring the real PlatformAccessory's optional third constructor argument.
 */
export class TestAccessory {

  // The HAP accessory category, kept as a plain number so a test asserts against the production constant rather than against a second literal. Optional exactly as
  // the real PlatformAccessory's third constructor argument is.
  public readonly category?: number;
  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  public readonly _associatedHAPAccessory: { displayName: string };
  public readonly services: TestService[] = [];

  public constructor(displayName: string, uuid: string, category?: number) {

    this.category = category;
    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { displayName };
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
  }

  // Mirror the real PlatformAccessory.updateDisplayName: write the display-name pair, ignoring an empty name exactly as Homebridge does.
  public updateDisplayName(name: string): void {

    if(name) {

      this.displayName = name;
      this._associatedHAPAccessory.displayName = name;
    }
  }

  /* Add a new service in either form HAP's real addService accepts: a service INSTANCE (what acquireService passes after constructing a namespace marker), or the
   * legacy (type, name?, subtype?) form. The instanceof check is sound because a marker CLASS is never an instance of TestService - only constructed services are.
   * Returns the service so production can immediately bind characteristics on it.
   */
  public addService(service: TestService): TestService;
  public addService(type: ServiceType, name?: string, subtype?: string): TestService;
  public addService(typeOrService: ServiceType | TestService, name?: string, subtype?: string): TestService {

    const service = (typeOrService instanceof TestService) ? typeOrService : new TestService(typeOrService, name ?? this.displayName, subtype);

    this.services.push(service);

    return service;
  }

  // Find the first service of the given type with no subtype. Production uses this for the "primary" service of a type.
  public getService(type: ServiceType): TestService | undefined {

    return this.services.find(service => (service.type === type) && (service.subtype === undefined));
  }

  // Find the service of the given type AND subtype. Production uses subtypes to disambiguate among multiple Valve or Switch services on one accessory.
  public getServiceById(type: ServiceType, subtype: string): TestService | undefined {

    return this.services.find(service => (service.type === type) && (service.subtype === subtype));
  }

  // Remove a service instance, mirroring HAP's PlatformAccessory.removeService - the path the real validService takes when a service fails validation and the
  // path the controller takes when it prunes a vanished zone's valve.
  public removeService(service: TestService): void {

    const index = this.services.indexOf(service);

    if(index !== -1) {

      this.services.splice(index, 1);
    }
  }
}

/**
 * Build a TestAccessory with a sensible default name and UUID. Pass overrides when a test needs a specific identity.
 *
 * @param displayName - the accessory's display name. Defaults to "Test Controller".
 * @param uuid        - the accessory's UUID. Defaults to the synthetic controller id so tests get reproducible identity by default.
 *
 * @returns a fresh TestAccessory pre-populated with an AccessoryInformation service.
 */
export function makeTestAccessory(displayName = "Test Controller", uuid = "500001"): TestAccessory {

  return new TestAccessory(displayName, uuid);
}
