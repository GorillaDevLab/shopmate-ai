import { DemoCommerceApiFixture } from "./demo-commerce-api-fixture.mjs";
export class DemoPersistentApiFixture extends DemoCommerceApiFixture {
  readonly readEnvironment: {
    readonly MOCK_PLATFORM_READ_DATABASE_URL: string;
    readonly MOCK_SOURCE_CURSOR_KEY: string;
  };
  publish(storeId: string, empty?: boolean): Promise<unknown>;
  holdEntityTable(): Promise<() => Promise<void>>;
  waitSourceQuery(): Promise<number>;
  waitBackendGone(pid: number): Promise<void>;
}
