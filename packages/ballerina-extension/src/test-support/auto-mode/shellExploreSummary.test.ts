// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * A shell command that only lists, searches and reads is named in the file tools' terms, for the
 * transcript's compact row (shell/explore-summary.ts); anything more keeps its terminal card.
 */

import { bashExploreSummary, powershellExploreSummary } from "../../features/ai/agent/shell/explore-summary";

const FILES = ["main.bal", "types.bal", "functions.bal", "Ballerina.toml", ".hidden.bal"];
const bash = (command: string) => bashExploreSummary(command, (dir) => (dir === "." ? FILES : []));

describe("bashExploreSummary", () => {
    it("names a listing, a search and a read", () => {
        expect(bash("ls")).toEqual({ listed: ["."], searched: [], read: [] });
        expect(bash("find modules -name '*.bal'")).toEqual({ listed: ["modules"], searched: [], read: [] });
        expect(bash("grep -rn TicketRecord .")).toEqual({ listed: [], searched: ["TicketRecord"], read: [] });
        expect(bash("rg -n 'http:Client' -g '*.bal'")).toEqual({ listed: [], searched: ["http:Client"], read: [] });
        expect(bash("cat main.bal types.bal")).toEqual({ listed: [], searched: [], read: ["main.bal", "types.bal"] });
        expect(bash("head -n 40 main.bal")).toEqual({ listed: [], searched: [], read: ["main.bal"] });
        expect(bash("nl main.bal")).toEqual({ listed: [], searched: [], read: ["main.bal"] });
    });

    it("expands a glob read and combines the parts of a line", () => {
        expect(bash("ls -R . | grep -v '^./target' | head -50; cat *.bal")).toEqual({
            listed: ["."],
            searched: [],
            read: ["main.bal", "types.bal", "functions.bal"],
        });
    });

    it("treats a searcher or reader fed by a pipe as a filter", () => {
        expect(bash("ls | grep bal")).toEqual({ listed: ["."], searched: [], read: [] });
        expect(bash("find . -name '*.bal' | sort | head -20")).toEqual({ listed: ["."], searched: [], read: [] });
    });

    it("takes the -e pattern of grep and git grep", () => {
        expect(bash("grep -rn -e foo src")).toEqual({ listed: [], searched: ["foo"], read: [] });
        expect(bash("git grep -n Client")).toEqual({ listed: [], searched: ["Client"], read: [] });
        expect(bash("git ls-files")).toEqual({ listed: ["."], searched: [], read: [] });
    });

    it("reads options with the gate's tables", () => {
        expect(bash("grep -rnA 3 foo src")).toEqual({ listed: [], searched: ["foo"], read: [] });
        expect(bash("rg --sort path foo src")).toEqual({ listed: [], searched: ["foo"], read: [] });
        expect(bash("rg --files src")).toEqual({ listed: ["src"], searched: [], read: [] });
        expect(bash("git grep -C 3 Client")).toEqual({ listed: [], searched: ["Client"], read: [] });
        expect(bash("git ls-files modules/orders")).toEqual({ listed: ["modules/orders"], searched: [], read: [] });
        expect(bash("grep -rn -e Foo -e Bar .")).toEqual({ listed: [], searched: ["Foo", "Bar"], read: [] });
    });

    it("allows a discarded stream", () => {
        expect(bash("ls modules 2>/dev/null")).toEqual({ listed: ["modules"], searched: [], read: [] });
    });

    it("keeps the card for anything more than a look", () => {
        for (const command of [
            "bal build",
            "cat main.bal > copy.bal",
            "sed -i 's/a/b/' main.bal",
            "sed -n '1,80p' main.bal",
            "find . -name '*.tmp' -delete",
            "find . -exec rm {} \\;",
            "cat $(ls *.bal)",
            "$CMD main.bal",
            "ls & sleep 1",
            "git status",
            "git grep -Ovim foo",
            "git -C sub grep -n Client",
            "cd modules/orders && cat *.bal",
            "wc -l main.bal",
            "echo hello",
            "cat <<EOF\nx\nEOF",
        ]) {
            expect(bash(command)).toBeUndefined();
        }
    });
});

describe("powershellExploreSummary", () => {
    it("names Get-ChildItem, Select-String and Get-Content in any spelling", () => {
        expect(powershellExploreSummary("Get-ChildItem -Recurse -Filter *.bal")).toEqual({ listed: ["."], searched: [], read: [] });
        expect(powershellExploreSummary("gci modules")).toEqual({ listed: ["modules"], searched: [], read: [] });
        expect(powershellExploreSummary("Get-ChildItem -ReadOnly src")).toEqual({ listed: ["src"], searched: [], read: [] });
        expect(powershellExploreSummary("Get-ChildItem modules *.bal -Recurse")).toEqual({ listed: ["modules"], searched: [], read: [] });
        expect(powershellExploreSummary("Select-String -Path *.bal -Pattern TicketRecord")).toEqual({ listed: [], searched: ["TicketRecord"], read: [] });
        expect(powershellExploreSummary("sls TicketRecord main.bal")).toEqual({ listed: [], searched: ["TicketRecord"], read: [] });
        expect(powershellExploreSummary("Get-Content main.bal")).toEqual({ listed: [], searched: [], read: ["main.bal"] });
        expect(powershellExploreSummary("Get-Content -Path main.bal | Select-Object -First 40")).toEqual({ listed: [], searched: [], read: ["main.bal"] });
    });

    it("keeps the card for anything more than a look", () => {
        for (const command of [
            "Set-Content a.bal 'x'",
            "Get-Content a.bal > b.bal",
            "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
            "Get-Content $(Get-Item a.bal)",
            "bal build",
            "Write-Output hello",
        ]) {
            expect(powershellExploreSummary(command)).toBeUndefined();
        }
    });
});
