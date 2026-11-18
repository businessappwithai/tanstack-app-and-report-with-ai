import { describeIntelligence } from "../../../interface/conformance";
import { createMemoryIntelligence } from "..";

describeIntelligence("memory provider", { make: () => createMemoryIntelligence() });
