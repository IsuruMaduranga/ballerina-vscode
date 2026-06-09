
type Address record {|
    string street;
    string city;
    string country;
|};

type EmployeeLog record {|
    string timestamp;
    string action;
    string userId;
    string description;
|};

type Employee record {|
    *Address;
    string employeeId;
    string department;
    decimal salary;
    EmployeeLog...;
|};

type DestinationConfig record {|
    string ashost;
    string sysnr;
    string user;
|};

type AdvancedConfig map<string>;
